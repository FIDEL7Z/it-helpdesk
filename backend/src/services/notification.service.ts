import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Types, type AnyBulkWriteOperation } from 'mongoose';
import { AssetModel, ProductModel, StockMovementModel, type MovementType, type StockMovementDocument } from '../models/inventory.model';
import { NotificationModel, NotificationStateModel, type Notification, type NotificationDocument, type NotificationType } from '../models/notification.model';
import { TicketModel, type TicketDocument, type TicketEvent } from '../models/ticket.model';
import { UserModel, type OptionalNotification } from '../models/user.model';
import { emailSettings } from './email/settings';
import { renderTicketMail, renderVerificationMail, type RenderedMail, type TicketMailKind } from './email/templates';

/*
 * Outbox for e-mail notifications.
 *
 * 1. The ticket or the stock movement is saved by its own service (unchanged rules).
 * 2. Right after, one row per event and recipient is upserted here, keyed by the event id: running
 *    it twice (a retried request, the reconciliation) never makes a second row.
 * 3. A processor claims due rows atomically (findOneAndUpdate with a lock that expires), renders
 *    and sends them, and records sent, skipped, a retry with backoff or a final failure.
 *
 * Steps 1 and 2 are separate writes (no multi-document transactions here). If the process dies in
 * between, the reconciliation rebuilds the rows from the ticket history and the stock ledger, which
 * are the source of truth. If it dies after the provider accepted a message but before step 3 is
 * recorded, the expired lock makes another attempt: Resend drops it by idempotency key (24 h);
 * Mailpit, a local inbox, may show it twice.
 */

export const NOTIFICATION_LIMITS = Object.freeze({
  lockMs: 60_000,
  maxAttempts: 5,
  /** Waits after attempts 1, 2, 3 and 4, plus up to 20% jitter. */
  backoffMs: [30_000, 120_000, 600_000, 1_800_000],
  reconcileWindowMs: 24 * 60 * 60_000,
  verificationTtlMs: 24 * 60 * 60_000,
  /** Minimum time between two confirmation e-mails asked by the same person. */
  verificationCooldownMs: 60_000,
});

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const ACTIVATION_ID = 'email-notifications';

/** Which ticket history events become an e-mail; everything else (edits, assignment, ratings) does not. */
function ticketNotificationType(event: TicketEvent): Exclude<NotificationType, 'material_delivered' | 'email_verification'> | null {
  const audit = event.audit;
  if (!audit?.eventId) return null; // Legacy events without an id cannot be deduplicated.
  switch (audit.eventType) {
    case 'created': return 'ticket_created';
    case 'resolved': return 'ticket_resolved';
    case 'reopened': return 'ticket_reopened';
    case 'status_changed': return audit.from?.status === 'aberto' && audit.to?.status === 'em_andamento' ? 'ticket_started' : null;
    default: return null;
  }
}

const DELIVERY_TYPES: readonly MovementType[] = ['issue', 'asset_assign'];

const PREFERENCE_OF: Partial<Record<NotificationType, OptionalNotification>> = {
  ticket_created: 'ticketCreated',
  ticket_started: 'ticketStarted',
  ticket_reopened: 'ticketReopened',
  material_delivered: 'materialDelivered',
  // ticket_resolved has no preference: it asks the requester to confirm the resolution.
};

function pendingRow(fields: Pick<Notification, 'key' | 'type' | 'recipient' | 'ticket' | 'source' | 'occurredAt'> & { targetEmail?: string | null }, now: Date) {
  return {
    ...fields,
    targetEmail: fields.targetEmail ?? null,
    status: 'pending' as const,
    attempts: 0,
    nextAttemptAt: now,
  };
}

async function upsertRows(rows: ReturnType<typeof pendingRow>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const operations: AnyBulkWriteOperation<Notification>[] = rows.map((row) => ({
    updateOne: { filter: { key: row.key }, update: { $setOnInsert: row }, upsert: true },
  }));
  const result = await NotificationModel.bulkWrite(operations, { ordered: false });
  return result.upsertedCount;
}

/**
 * Queues the notifications of a ticket's history events (all of them, or those selected).
 * The recipient is the ticket's requester, read from the stored ticket. An event done by the
 * requester themselves is not mailed back to them, except the receipt of a new request.
 */
export async function enqueueTicketEvents(ticket: TicketDocument, select: (event: TicketEvent) => boolean = () => true): Promise<number> {
  if (!emailSettings().enabled) return 0;
  const now = new Date();
  const rows = ticket.history.flatMap((event) => {
    const type = ticketNotificationType(event);
    if (!type || !select(event)) return [];
    const audit = event.audit!;
    if (type !== 'ticket_created' && audit.actorId?.equals(ticket.requester)) return [];
    return [pendingRow({
      key: `ticket-event:${audit.eventId}:${ticket.requester.toString()}`,
      type,
      recipient: ticket.requester,
      ticket: ticket._id,
      source: { kind: 'ticket_event', id: audit.eventId },
      occurredAt: audit.occurredAt,
    }, now)];
  });
  return upsertRows(rows);
}

/** A delivery (quantity or tagged asset) linked to a ticket notifies the ticket's requester. */
export async function enqueueMovement(movement: StockMovementDocument): Promise<number> {
  if (!emailSettings().enabled || !movement.ticket || !DELIVERY_TYPES.includes(movement.type)) return 0;
  const ticket = await TicketModel.findById(movement.ticket).select('requester');
  if (!ticket || movement.actor.equals(ticket.requester)) return 0;
  return upsertRows([pendingRow({
    key: `stock-movement:${movement.id}:${ticket.requester.toString()}`,
    type: 'material_delivered',
    recipient: ticket.requester,
    ticket: ticket._id,
    source: { kind: 'stock_movement', id: movement.id },
    occurredAt: movement.occurredAt,
  }, new Date())]);
}

/**
 * Called by the ticket and stock services after their own write succeeded. A failure here is
 * logged and left to the reconciliation: it never fails or slows down the ticket operation
 * beyond one upsert.
 */
export async function notifySafely(task: () => Promise<number>, context: string): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`[notifications] could not queue (${context}); the reconciliation will retry:`, error instanceof Error ? error.message : error);
  }
}

// ---------- Recipients and addresses ----------

const RESERVED_DOMAIN = /\.(local|localhost|test|example|invalid)$/i;

/** Outside production, a real provider sends only to the allowlist; reserved domains never leave. Mailpit keeps everything local. */
export function deliverableAddress(address: string): { ok: true } | { ok: false; reason: string } {
  const settings = emailSettings();
  if (settings.provider.name === 'mailpit') return { ok: true };
  const domain = address.split('@')[1] ?? '';
  if (RESERVED_DOMAIN.test(domain) || /(^|\.)example\.(com|org|net)$/i.test(domain)) return { ok: false, reason: 'reserved_address' };
  if (settings.production) return { ok: true };
  const lower = address.toLowerCase();
  const allowed = settings.allowlist.some((entry) => (entry.startsWith('@') ? lower.endsWith(entry) : lower === entry));
  return allowed ? { ok: true } : { ok: false, reason: 'recipient_not_in_allowlist' };
}

// ---------- Rendering ----------

type Prepared = { send: true; to: { email: string; name: string }; mail: RenderedMail; idempotencyKey: string } | { send: false; reason: string };

async function prepare(notification: NotificationDocument): Promise<Prepared> {
  const user = await UserModel.findById(notification.recipient);
  if (!user?.active) return { send: false, reason: 'recipient_inactive' };
  const settings = emailSettings();
  const context = { appUrl: settings.appUrl, timezone: settings.timezone };

  if (notification.type === 'email_verification') {
    const target = notification.targetEmail;
    if (!target) return { send: false, reason: 'no_target' };
    const changing = target !== user.email;
    if (!changing && user.emailVerifiedAt) return { send: false, reason: 'already_verified' };
    if (changing && user.pendingEmail !== target) return { send: false, reason: 'superseded' };
    const address = deliverableAddress(target);
    if (!address.ok) return { send: false, reason: address.reason };
    // A fresh single-use token per attempt; only its hash is stored, the link exists only in the e-mail.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + NOTIFICATION_LIMITS.verificationTtlMs);
    await UserModel.updateOne({ _id: user._id }, { $set: { emailVerification: { tokenHash: hashToken(token), email: target, expiresAt } } });
    return {
      send: true,
      to: { email: target, name: user.name },
      mail: renderVerificationMail({ recipientName: user.name, confirmUrl: `${settings.appUrl}/account/confirm-email?token=${token}`, expiresAt, isChange: changing }, context),
      idempotencyKey: `${notification.key}:attempt-${notification.attempts}`,
    };
  }

  if (!user.emailVerifiedAt) return { send: false, reason: 'email_not_verified' };
  const preference = PREFERENCE_OF[notification.type];
  if (preference && user.notificationPreferences?.[preference] === false) return { send: false, reason: 'preference_off' };
  const address = deliverableAddress(user.email);
  if (!address.ok) return { send: false, reason: address.reason };

  const ticket = await TicketModel.findById(notification.ticket);
  // Defense in depth: the row was built from the ticket's requester; check it still is.
  if (!ticket || !ticket.requester.equals(user._id)) return { send: false, reason: 'recipient_mismatch' };

  let responsibleName: string | null = null;
  let items: string[] | undefined;
  if (notification.type === 'material_delivered') {
    const movement = await StockMovementModel.findById(notification.source.id);
    if (!movement || !movement.ticket?.equals(ticket._id)) return { send: false, reason: 'source_missing' };
    if (await StockMovementModel.exists({ reverses: movement._id })) return { send: false, reason: 'delivery_reversed' };
    const product = await ProductModel.findById(movement.product).select('name');
    // The tag of an asset is shown only to the person who received it, as on the ticket page.
    const asset = movement.asset && movement.recipient?.id.equals(user._id) ? await AssetModel.findById(movement.asset).select('assetTag') : null;
    items = [`${movement.quantity} × ${product?.name ?? 'Material'}${asset ? ` (patrimônio ${asset.assetTag})` : ''}`];
  } else {
    const event = ticket.history.find((item) => item.audit?.eventId === notification.source.id);
    if (!event) return { send: false, reason: 'source_missing' };
    if (notification.type === 'ticket_started') responsibleName = event.audit?.assigneeSnapshot?.name ?? null;
  }

  return {
    send: true,
    to: { email: user.email, name: user.name },
    mail: renderTicketMail({
      kind: notification.type as TicketMailKind,
      recipientName: user.name,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      occurredAt: notification.occurredAt,
      responsibleName,
      items,
    }, context),
    idempotencyKey: notification.key,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------- Processing ----------

/** Atomically takes one due row (pending and due, or sending with an expired lock) for this worker. */
export async function claimNext(now = new Date(), worker = WORKER_ID): Promise<NotificationDocument | null> {
  return NotificationModel.findOneAndUpdate(
    { $or: [{ status: 'pending', nextAttemptAt: { $lte: now } }, { status: 'sending', lockedUntil: { $lt: now } }] },
    { $set: { status: 'sending', lockedUntil: new Date(now.getTime() + NOTIFICATION_LIMITS.lockMs), lockedBy: worker }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
  );
}

export function backoffFor(attempts: number): number {
  const base = NOTIFICATION_LIMITS.backoffMs[Math.min(attempts, NOTIFICATION_LIMITS.backoffMs.length) - 1] ?? NOTIFICATION_LIMITS.backoffMs.at(-1)!;
  return base + Math.floor(Math.random() * base * 0.2);
}

export type ProcessOutcome = 'sent' | 'skipped' | 'retry' | 'failed' | 'lost_lock';

/** Only the worker holding the lock may record the outcome (another one may have reclaimed it). */
async function finish(notification: NotificationDocument, worker: string, set: Partial<Notification>): Promise<boolean> {
  const result = await NotificationModel.updateOne(
    { _id: notification._id, status: 'sending', lockedBy: worker },
    { $set: { ...set, lockedUntil: null, lockedBy: null } },
  );
  return result.modifiedCount === 1;
}

export async function processNotification(notification: NotificationDocument, worker = WORKER_ID): Promise<ProcessOutcome> {
  const provider = emailSettings().provider;
  let outcome: ProcessOutcome;
  let set: Partial<Notification>;
  try {
    const prepared = await prepare(notification);
    if (!prepared.send) {
      outcome = 'skipped';
      set = { status: 'skipped', skipReason: prepared.reason };
    } else {
      const result = await provider.send({ to: prepared.to, subject: prepared.mail.subject, html: prepared.mail.html, text: prepared.mail.text, idempotencyKey: prepared.idempotencyKey });
      if (result.ok) {
        outcome = 'sent';
        set = { status: 'sent', sentAt: new Date(), provider: provider.name, providerMessageId: result.id, sentTo: prepared.to.email, lastError: null };
      } else if (result.retryable && notification.attempts < NOTIFICATION_LIMITS.maxAttempts) {
        outcome = 'retry';
        set = { status: 'pending', provider: provider.name, lastError: result.reason, nextAttemptAt: new Date(Date.now() + backoffFor(notification.attempts)) };
      } else {
        outcome = 'failed';
        set = { status: 'failed', provider: provider.name, lastError: result.reason };
      }
    }
  } catch (error) {
    // A bug or a database hiccup: treated like a temporary failure, without the message content.
    const reason = `internal_error: ${error instanceof Error ? error.name : 'unknown'}`;
    outcome = notification.attempts < NOTIFICATION_LIMITS.maxAttempts ? 'retry' : 'failed';
    set = outcome === 'retry'
      ? { status: 'pending', lastError: reason, nextAttemptAt: new Date(Date.now() + backoffFor(notification.attempts)) }
      : { status: 'failed', lastError: reason };
  }
  return (await finish(notification, worker, set)) ? outcome : 'lost_lock';
}

export async function processDueNotifications(options: { limit?: number; now?: () => Date; worker?: string } = {}): Promise<Record<ProcessOutcome, number>> {
  const counts: Record<ProcessOutcome, number> = { sent: 0, skipped: 0, retry: 0, failed: 0, lost_lock: 0 };
  const limit = options.limit ?? 20;
  for (let i = 0; i < limit; i += 1) {
    const claimed = await claimNext(options.now?.() ?? new Date(), options.worker);
    if (!claimed) break;
    counts[await processNotification(claimed, options.worker)] += 1;
  }
  return counts;
}

// ---------- Recovery ----------

/** Records when notifications were first turned on (kept; later calls do not move it). */
export async function ensureActivation(now = new Date()): Promise<Date> {
  const state = await NotificationStateModel.findOneAndUpdate(
    { _id: ACTIVATION_ID },
    { $setOnInsert: { activatedAt: now } },
    { upsert: true, returnDocument: 'after' },
  );
  return state!.activatedAt;
}

/**
 * Rebuilds rows that were never queued (process stopped between the ticket write and the queue
 * write). Looks at the last 24 hours, never before activation, and relies on the idempotent keys.
 */
export async function reconcileNotifications(now = new Date()): Promise<number> {
  if (!emailSettings().enabled) return 0;
  const activatedAt = await ensureActivation(now);
  const since = new Date(Math.max(activatedAt.getTime(), now.getTime() - NOTIFICATION_LIMITS.reconcileWindowMs));
  let queued = 0;
  const tickets = await TicketModel.find({ history: { $elemMatch: { 'audit.occurredAt': { $gte: since }, 'audit.eventType': { $in: ['created', 'status_changed', 'resolved', 'reopened'] } } } });
  for (const ticket of tickets) queued += await enqueueTicketEvents(ticket, (event) => !!event.audit && event.audit.occurredAt >= since);
  const movements = await StockMovementModel.find({ ticket: { $ne: null }, type: { $in: DELIVERY_TYPES }, occurredAt: { $gte: since } });
  for (const movement of movements) queued += await enqueueMovement(movement);
  return queued;
}

// ---------- Background loop ----------

let processTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let busy = false;

/** Starts the in-process processor (only when e-mail is enabled). Pending rows survive restarts in MongoDB. */
export function startNotificationProcessor(options: { intervalMs?: number; reconcileMs?: number } = {}): boolean {
  if (!emailSettings().enabled || processTimer) return false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await processDueNotifications();
    } catch (error) {
      console.error('[notifications] processing failed:', error instanceof Error ? error.message : error);
    } finally {
      busy = false;
    }
  };
  const reconcile = () => reconcileNotifications().catch((error) => console.error('[notifications] reconciliation failed:', error instanceof Error ? error.message : error));
  void reconcile().then(tick);
  processTimer = setInterval(tick, options.intervalMs ?? 5_000);
  reconcileTimer = setInterval(reconcile, options.reconcileMs ?? 5 * 60_000);
  processTimer.unref();
  reconcileTimer.unref();
  return true;
}

export function stopNotificationProcessor(): void {
  if (processTimer) clearInterval(processTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  processTimer = null;
  reconcileTimer = null;
}

// ---------- Account ----------

/** Queues a confirmation e-mail for the account's current (unconfirmed) or pending address. */
export async function enqueueEmailVerification(userId: Types.ObjectId, targetEmail: string, now = new Date()): Promise<void> {
  await NotificationModel.create(pendingRow({
    key: `email-verification:${userId.toString()}:${randomUUID()}`,
    type: 'email_verification',
    recipient: userId,
    ticket: null,
    source: { kind: 'account', id: userId.toString() },
    occurredAt: now,
    targetEmail,
  }, now));
}

export async function lastVerificationRequest(userId: Types.ObjectId): Promise<Date | null> {
  const last = await NotificationModel.findOne({ recipient: userId, type: 'email_verification' }).sort({ createdAt: -1 }).select('createdAt');
  return last?.createdAt ?? null;
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  status: Notification['status'];
  ticketId: string | null;
  createdAt: string;
  sentAt: string | null;
  attempts: number;
  skipReason: string | null;
}

/** The person's own latest notifications (status only; no content, no provider details). */
export async function listOwnNotifications(userId: string, limit = 10): Promise<NotificationView[]> {
  const rows = await NotificationModel.find({ recipient: userId }).sort({ createdAt: -1 }).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    ticketId: row.ticket?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    attempts: row.attempts,
    skipReason: row.skipReason,
  }));
}
