import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * E-mail notifications are an outbox: the ticket (or the stock movement) is saved first, then one
 * document per event and recipient is upserted here, and a background processor sends it. MongoDB
 * here has no multi-document transactions, so the two writes are not atomic; a reconciliation pass
 * rebuilds missing rows from the ticket history and the stock ledger (see notification.service).
 */
export const NOTIFICATION_TYPES = ['ticket_created', 'ticket_started', 'ticket_resolved', 'ticket_reopened', 'material_delivered', 'email_verification'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** pending → sending → sent | failed; skipped when the rules say not to send (no confirmed e-mail, preference, address). */
export const NOTIFICATION_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface Notification {
  /** Idempotency key: one row per source event and recipient (also sent to the provider). */
  key: string;
  type: NotificationType;
  /** Always a stored user: the ticket's requester or the account owner. Never an address from a request. */
  recipient: Types.ObjectId;
  ticket: Types.ObjectId | null;
  source: { kind: 'ticket_event' | 'stock_movement' | 'account'; id: string };
  /** When the source event happened (ticket history or ledger time). */
  occurredAt: Date;
  /** Only for e-mail confirmation: the address being confirmed. */
  targetEmail: string | null;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  provider: string | null;
  providerMessageId: string | null;
  /** The address actually used, kept for audit of what was sent to whom. */
  sentTo: string | null;
  sentAt: Date | null;
  /** Short, sanitized reason (provider error class or rule), never message content. */
  lastError: string | null;
  skipReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;

const notificationSchema = new Schema<Notification>(
  {
    key: { type: String, required: true, maxlength: 256 },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    source: {
      type: new Schema({ kind: { type: String, enum: ['ticket_event', 'stock_movement', 'account'], required: true }, id: { type: String, required: true } }, { _id: false }),
      required: true,
    },
    occurredAt: { type: Date, required: true },
    targetEmail: { type: String, default: null },
    status: { type: String, enum: NOTIFICATION_STATUSES, required: true, default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    provider: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    sentTo: { type: String, default: null },
    sentAt: { type: Date, default: null },
    lastError: { type: String, maxlength: 300, default: null },
    skipReason: { type: String, maxlength: 80, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ key: 1 }, { unique: true });
// The processor's claim query: due pending rows and expired locks, oldest first.
notificationSchema.index({ status: 1, nextAttemptAt: 1 });
notificationSchema.index({ status: 1, lockedUntil: 1 });
notificationSchema.index({ recipient: 1, createdAt: -1 });

export const NotificationModel = model<Notification>('Notification', notificationSchema);

/**
 * When notifications were first turned on. The reconciliation only rebuilds events after this
 * moment, so enabling e-mail never mails people about old history.
 */
const notificationStateSchema = new Schema<{ _id: string; activatedAt: Date }>({
  _id: { type: String, required: true },
  activatedAt: { type: Date, required: true },
});

export const NotificationStateModel = model('NotificationState', notificationStateSchema);
