import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { ProductModel, StockMovementModel } from '../src/models/inventory.model';
import { NotificationModel, NotificationStateModel } from '../src/models/notification.model';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { spawnSync } from 'node:child_process';
import nodemailer from 'nodemailer';
import {
  GMAIL_SMTP, classifySmtpError, gmailProvider, mailpitProvider, resendProvider, type EmailProvider, type OutgoingEmail, type SendResult,
} from '../src/services/email/providers';
import { setEmailSettingsForTests } from '../src/services/email/settings';
import {
  NOTIFICATION_LIMITS, claimNext, ensureActivation, processDueNotifications, processNotification, reconcileNotifications,
} from '../src/services/notification.service';
import { signAccessToken } from '../src/utils/jwt';
import { hashPassword } from '../src/utils/password';

// E-mail notifications: who receives what, when, and what happens when the provider fails.
// Providers are fakes (memory or a local HTTP server): no message ever leaves this machine.
const TEST_DB_NAME = 'it-helpdesk-test-notifications';
const PASSWORD = 'Senha-de-teste-123';
const APP_URL = 'http://helpdesk.example.test';

type Json = { [key: string]: any };
type TestUser = { id: string; token: string; email: string };

let server: Server;
let baseUrl: string;
let maria: TestUser, paulo: TestUser, carlos: TestUser, ana: TestUser, demo: TestUser;
let keyboard: Json;

/** Records messages; can be told to fail the next sends. Named "mailpit" so addresses are not filtered. */
class MemoryProvider implements EmailProvider {
  sent: OutgoingEmail[] = [];
  failures: SendResult[] = [];
  constructor(readonly name = 'mailpit') {}
  async send(message: OutgoingEmail): Promise<SendResult> {
    const failure = this.failures.shift();
    if (failure) return failure;
    this.sent.push(message);
    return { ok: true, id: `memory-${this.sent.length}` };
  }
}
let provider: MemoryProvider;

function useEmail(overrides: Json = {}) {
  setEmailSettingsForTests({ enabled: true, provider, appUrl: APP_URL, allowlist: [], production: false, timezone: 'America/Fortaleza', ...overrides });
}

async function api(method: string, path: string, user: TestUser | null, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, role: UserRole, options: { email?: string; verified?: boolean } = {}): Promise<TestUser> {
  const email = options.email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@notifications.test`;
  const user = await UserModel.create({ name, email, role, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: options.verified ? new Date() : null });
  return { id: user.id, token: signAccessToken(user.id), email };
}

const op = () => randomUUID();
const revisionOf = async (id: string) => (await api('GET', `/tickets/${id}`, carlos)).body.ticket.revision;
const openTicket = async (user: TestUser, title = 'Teclado parou de funcionar') => {
  const created = await api('POST', '/tickets', user, { title, description: 'Metade das teclas não responde desde cedo.', category: 'hardware' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.ticket as Json;
};
const setStatus = async (id: string, status: string, user = carlos, reason?: string) => {
  const result = await api('PATCH', `/tickets/${id}/status`, user, { status, expectedRevision: await revisionOf(id), ...(reason && { reason }) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.ticket as Json;
};
const rowsFor = (ticketId: string) => NotificationModel.find({ ticket: ticketId }).sort({ occurredAt: 1, _id: 1 });
const typesFor = async (ticketId: string) => (await rowsFor(ticketId)).map((row) => row.type);
const tokenFrom = (message: OutgoingEmail) => /token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1] ?? '';

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel, TicketModel, NotificationModel, ProductModel, StockMovementModel].map((model) => model.syncIndexes()));
  maria = await createUser('Maria Oliveira', 'solicitante', { verified: true });
  paulo = await createUser('Paulo Souza', 'solicitante');
  carlos = await createUser('Carlos Andrade', 'ti', { verified: true });
  ana = await createUser('Ana Ribeiro', 'gestor', { verified: true });
  demo = await createUser('Mariana Souza', 'solicitante', { email: 'solicitante@helpdesk.local' });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  provider = new MemoryProvider();
  useEmail();
  keyboard = (await api('POST', '/inventory/products', carlos, { name: 'Teclado Logitech K120', type: 'teclado', tracking: 'quantity' })).body.product;
  await api('POST', `/inventory/products/${keyboard.id}/receipts`, carlos, { operationId: op(), quantity: 10 });
});

beforeEach(async () => {
  provider = new MemoryProvider();
  useEmail();
  await NotificationModel.deleteMany({});
  await UserModel.updateOne({ _id: maria.id }, { $set: { notificationPreferences: {} } });
});

afterEach(() => setEmailSettingsForTests(null));

after(async () => {
  setEmailSettingsForTests(null);
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('what is queued', () => {
  it('queues one receipt for the requester when a ticket is created', async () => {
    const ticket = await openTicket(maria);
    const rows = await rowsFor(ticket.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'ticket_created');
    assert.equal(rows[0].recipient.toString(), maria.id);
    assert.equal(rows[0].status, 'pending');
  });

  it('queues start, resolution and a reopening by the team, but not assignment, edits or the requester own answers', async () => {
    const ticket = await openTicket(maria);
    await setStatus(ticket.id, 'em_andamento');
    await setStatus(ticket.id, 'resolvido');
    await setStatus(ticket.id, 'em_andamento', carlos, 'O teclado voltou a falhar depois do teste.');
    await setStatus(ticket.id, 'resolvido');
    assert.deepEqual(await typesFor(ticket.id), ['ticket_created', 'ticket_started', 'ticket_resolved', 'ticket_reopened', 'ticket_resolved']);

    // The requester contests (reopens) and later confirms: they did it, so no e-mail to themselves.
    const cycle = (await api('GET', `/tickets/${ticket.id}`, carlos)).body.ticket.activeCycleId;
    const contested = await api('POST', `/tickets/${ticket.id}/resolution/contest`, maria, { cycleId: cycle, reason: 'Ainda não funciona.' });
    assert.equal(contested.status, 200, JSON.stringify(contested.body));
    await setStatus(ticket.id, 'resolvido');
    const confirmed = await api('POST', `/tickets/${ticket.id}/resolution/confirm`, maria, { cycleId: cycle + 1 });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual((await typesFor(ticket.id)).slice(5), ['ticket_resolved']);
  });

  it('queues a delivery linked to the ticket for its requester, once, and nothing for deliveries without a ticket', async () => {
    const ticket = await openTicket(maria);
    const operationId = op();
    const body = { operationId, quantity: 1, ticketId: ticket.id, recipientId: maria.id };
    assert.equal((await api('POST', `/inventory/products/${keyboard.id}/issues`, carlos, body)).status, 201);
    assert.equal((await api('POST', `/inventory/products/${keyboard.id}/issues`, carlos, body)).status, 200); // replay
    await api('POST', `/inventory/products/${keyboard.id}/issues`, carlos, { operationId: op(), quantity: 1, recipientId: paulo.id });
    const deliveries = await NotificationModel.find({ type: 'material_delivered' });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].recipient.toString(), maria.id);
    assert.equal(deliveries[0].ticket?.toString(), ticket.id);
  });

  it('never takes the recipient from the request', async () => {
    const forged = await api('POST', '/tickets', maria, { title: 'Monitor sem imagem', description: 'O monitor não liga desde ontem à tarde.', category: 'hardware', requester: carlos.id, email: 'outra.pessoa@empresa.com' });
    assert.equal(forged.status, 400);
    const ticket = await openTicket(maria);
    // Someone else cannot act on Maria's ticket, so no e-mail can be triggered through it.
    assert.equal((await api('GET', `/tickets/${ticket.id}`, paulo)).status, 404);
    assert.equal((await api('POST', `/tickets/${ticket.id}/resolution/confirm`, paulo, { cycleId: 1 })).status, 404);
    const recipients = new Set((await NotificationModel.find({})).map((row) => row.recipient.toString()));
    assert.deepEqual([...recipients], [maria.id]);
  });

  it('queues nothing while e-mail is off, and tickets keep working', async () => {
    setEmailSettingsForTests({ enabled: false, provider });
    const ticket = await openTicket(maria);
    await setStatus(ticket.id, 'em_andamento');
    assert.equal(await NotificationModel.countDocuments({}), 0);
    assert.deepEqual(await processDueNotifications(), { sent: 0, skipped: 0, retry: 0, failed: 0, lost_lock: 0 });
  });

  it('does not fail the ticket when queueing fails, and the reconciliation rebuilds the row', async () => {
    // As at server start: e-mail was turned on before this ticket existed.
    await NotificationStateModel.deleteMany({});
    await ensureActivation(new Date(Date.now() - 1_000));
    const original = NotificationModel.bulkWrite.bind(NotificationModel);
    (NotificationModel as Json).bulkWrite = async () => { throw new Error('database unavailable'); };
    let ticket: Json;
    try {
      ticket = await openTicket(maria, 'Impressora sem papel');
    } finally {
      (NotificationModel as Json).bulkWrite = original;
    }
    assert.equal(await NotificationModel.countDocuments({ ticket: ticket.id }), 0);
    assert.ok(await reconcileNotifications() >= 1);
    assert.deepEqual(await typesFor(ticket.id), ['ticket_created']);
    assert.equal(await reconcileNotifications(), 0, 'running it again queues nothing new');
  });

  it('does not rebuild events from before e-mail was turned on', async () => {
    setEmailSettingsForTests({ enabled: false, provider });
    const old = await openTicket(maria, 'Pedido antigo');
    useEmail();
    await NotificationStateModel.deleteMany({});
    await NotificationStateModel.create({ _id: 'email-notifications', activatedAt: new Date(Date.now() + 1_000) });
    await reconcileNotifications(new Date(Date.now() + 2_000));
    assert.equal(await NotificationModel.countDocuments({ ticket: old.id }), 0);
    await NotificationStateModel.deleteMany({});
  });
});

describe('sending', () => {
  it('sends only to the confirmed e-mail of the requester, with the ticket link and no internal text', async () => {
    const ticket = await openTicket(maria, 'Teclado <b>quebrado</b> & lento');
    await setStatus(ticket.id, 'em_andamento');
    // Ana resolves Carlos's ticket: her justification is internal and must not reach the requester.
    await setStatus(ticket.id, 'resolvido', ana, 'NOTA-INTERNA: trocado sem abrir chamado de garantia.');
    const counts = await processDueNotifications();
    assert.equal(counts.sent, 3);
    assert.ok(provider.sent.every((mail) => mail.to.email === maria.email));
    const resolved = provider.sent[2];
    assert.match(resolved.subject, /resolvido/);
    assert.match(resolved.subject, new RegExp(`#${ticket.id.slice(-6)}`));
    assert.ok(resolved.html.includes(`${APP_URL}/tickets/${ticket.id}`));
    assert.ok(resolved.text.includes(`${APP_URL}/tickets/${ticket.id}`));
    assert.ok(resolved.html.includes('Teclado &lt;b&gt;quebrado&lt;/b&gt; &amp; lento'));
    for (const mail of provider.sent) {
      assert.doesNotMatch(mail.html + mail.text, /NOTA-INTERNA|garantia|Bearer|password|senha/i);
      assert.doesNotMatch(mail.html + mail.text, /@notifications\.test/, 'no addresses of anyone in the body');
      assert.match(mail.text, /Mensagem automática/);
    }
    const started = provider.sent[1];
    assert.match(started.text, /Carlos Andrade está cuidando/);
    const rows = await rowsFor(ticket.id);
    assert.ok(rows.every((row) => row.status === 'sent' && row.sentTo === maria.email && row.attempts === 1));
  });

  it('skips people without a confirmed e-mail', async () => {
    const ticket = await openTicket(paulo);
    assert.equal((await processDueNotifications()).skipped, 1);
    const [row] = await rowsFor(ticket.id);
    assert.equal(row.status, 'skipped');
    assert.equal(row.skipReason, 'email_not_verified');
    assert.equal(provider.sent.length, 0);
  });

  it('respects optional preferences but always sends the resolution, which asks for a confirmation', async () => {
    await UserModel.updateOne({ _id: maria.id }, { $set: { 'notificationPreferences.ticketCreated': false, 'notificationPreferences.ticketStarted': false } });
    const ticket = await openTicket(maria);
    await setStatus(ticket.id, 'em_andamento');
    await setStatus(ticket.id, 'resolvido');
    await processDueNotifications();
    const rows = await rowsFor(ticket.id);
    assert.deepEqual(rows.map((row) => [row.type, row.status, row.skipReason]), [
      ['ticket_created', 'skipped', 'preference_off'],
      ['ticket_started', 'skipped', 'preference_off'],
      ['ticket_resolved', 'sent', null],
    ]);
  });

  it('describes a delivery with the material and skips it if the delivery was reversed before sending', async () => {
    const ticket = await openTicket(maria);
    await api('POST', `/inventory/products/${keyboard.id}/issues`, carlos, { operationId: op(), quantity: 2, ticketId: ticket.id, recipientId: maria.id });
    await processDueNotifications();
    const delivery = provider.sent.find((mail) => /Material entregue/.test(mail.subject));
    assert.ok(delivery);
    assert.match(delivery.text, /2 × Teclado Logitech K120/);

    const second = await openTicket(maria);
    await api('POST', `/inventory/products/${keyboard.id}/issues`, carlos, { operationId: op(), quantity: 1, ticketId: second.id, recipientId: maria.id });
    const movement = await StockMovementModel.findOne({ ticket: second.id, type: 'issue' });
    const reversed = await api('POST', `/inventory/products/${keyboard.id}/reversals`, ana, { operationId: op(), movementId: movement!.id, reason: 'Entrega registrada no pedido errado.' });
    assert.equal(reversed.status, 201, JSON.stringify(reversed.body));
    await processDueNotifications();
    const row = await NotificationModel.findOne({ ticket: second.id, type: 'material_delivered' });
    assert.equal(row?.skipReason, 'delivery_reversed');
  });

  it('retries temporary failures with backoff and gives up after the limit', async () => {
    const ticket = await openTicket(maria);
    provider.failures = Array.from({ length: NOTIFICATION_LIMITS.maxAttempts }, () => ({ ok: false as const, retryable: true, reason: 'network' }));
    let now = Date.now();
    const first = await processDueNotifications({ now: () => new Date(now) });
    assert.equal(first.retry, 1);
    let [row] = await rowsFor(ticket.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, 'network');
    assert.ok(row.nextAttemptAt.getTime() >= now + NOTIFICATION_LIMITS.backoffMs[0]);
    assert.equal((await processDueNotifications({ now: () => new Date(now) })).retry, 0, 'not due yet');
    for (let attempt = 2; attempt <= NOTIFICATION_LIMITS.maxAttempts; attempt += 1) {
      now += 3 * 60 * 60_000;
      await processDueNotifications({ now: () => new Date(now) });
    }
    [row] = await rowsFor(ticket.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, NOTIFICATION_LIMITS.maxAttempts);
    assert.equal(provider.sent.length, 0);
  });

  it('does not retry a request the provider rejects as invalid', async () => {
    const ticket = await openTicket(maria);
    provider.failures = [{ ok: false, retryable: false, reason: 'validation_error (422)' }];
    assert.equal((await processDueNotifications()).failed, 1);
    const [row] = await rowsFor(ticket.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
  });

  it('keeps the same idempotency key on every attempt', async () => {
    await openTicket(maria);
    const keys: string[] = [];
    const recording: EmailProvider = { name: 'mailpit', send: async (mail) => { keys.push(mail.idempotencyKey); return keys.length === 1 ? { ok: false, retryable: true, reason: 'timeout' } : { ok: true, id: 'x' }; } };
    useEmail({ provider: recording });
    const now = Date.now();
    await processDueNotifications({ now: () => new Date(now) });
    await processDueNotifications({ now: () => new Date(now + 60 * 60_000) });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });

  it('sends each notification once when two processors run at the same time', async () => {
    for (let i = 0; i < 6; i += 1) await openTicket(maria, `Pedido simultâneo ${i}`);
    const [a, b] = await Promise.all([
      processDueNotifications({ worker: 'worker-a' }),
      processDueNotifications({ worker: 'worker-b' }),
    ]);
    assert.equal(a.sent + b.sent, 6);
    assert.equal(provider.sent.length, 6);
    assert.equal(new Set(provider.sent.map((mail) => mail.idempotencyKey)).size, 6);
  });

  it('resumes after a restart: expired locks are claimed again and pending rows are sent', async () => {
    const stuck = await openTicket(maria, 'Pedido travado');
    const waiting = await openTicket(maria, 'Pedido na fila');
    // A worker took this row and died before recording the result.
    await NotificationModel.updateOne({ ticket: stuck.id }, { $set: { status: 'sending', lockedBy: 'dead-worker', lockedUntil: new Date(Date.now() - 1_000), attempts: 1 } });
    const counts = await processDueNotifications({ worker: 'new-process' });
    assert.equal(counts.sent, 2);
    const rows = await NotificationModel.find({ ticket: { $in: [stuck.id, waiting.id] } });
    assert.ok(rows.every((row) => row.status === 'sent' && row.lockedBy === null));
    assert.equal(rows.find((row) => row.ticket?.toString() === stuck.id)?.attempts, 2);
  });

  it('a worker that lost its lock does not overwrite the result of the worker that took over', async () => {
    const ticket = await openTicket(maria);
    const now = Date.now();
    const slow = await claimNext(new Date(now), 'slow-worker');
    assert.ok(slow);
    // The lock expires and another worker claims and finishes the row.
    const fast = await claimNext(new Date(now + NOTIFICATION_LIMITS.lockMs + 1), 'fast-worker');
    assert.equal(fast?.id, slow.id);
    assert.equal(await processNotification(fast!, 'fast-worker'), 'sent');
    assert.equal(await processNotification(slow, 'slow-worker'), 'lost_lock');
    const [row] = await rowsFor(ticket.id);
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 2);
  });

  it('only delivers to allowlisted addresses with a real provider outside production', async () => {
    const real = new MemoryProvider('resend');
    const allowed = await createUser('Pessoa Liberada', 'solicitante', { email: 'liberada@helpdesk-avaliacao.dev', verified: true });
    const blocked = await createUser('Pessoa Bloqueada', 'solicitante', { email: 'bloqueada@helpdesk-avaliacao.dev', verified: true });
    useEmail({ provider: real, allowlist: ['liberada@helpdesk-avaliacao.dev'] });
    await openTicket(allowed);
    await openTicket(blocked);
    await openTicket(maria); // @notifications.test: a reserved domain, never sent by a real provider
    await processDueNotifications();
    assert.deepEqual(real.sent.map((mail) => mail.to.email), ['liberada@helpdesk-avaliacao.dev']);
    const reasons = (await NotificationModel.find({ status: 'skipped' })).map((row) => row.skipReason).sort();
    assert.deepEqual(reasons, ['recipient_not_in_allowlist', 'reserved_address']);
  });
});

describe('account e-mail and preferences', () => {
  it('shows only the authenticated person their e-mail, confirmation and notifications', async () => {
    const ticket = await openTicket(maria);
    await openTicket(paulo);
    const account = await api('GET', '/account', maria);
    assert.equal(account.status, 200);
    assert.equal(account.body.account.email, maria.email);
    assert.equal(account.body.account.emailVerified, true);
    assert.deepEqual(account.body.account.preferences, { ticketCreated: true, ticketStarted: true, ticketReopened: true, materialDelivered: true });
    assert.deepEqual(account.body.account.notifications.map((item: Json) => item.ticketId), [ticket.id]);
    assert.equal((await api('GET', '/account', null)).status, 401);
  });

  it('confirms an address through the link sent to that inbox, once', async () => {
    const asked = await api('POST', '/account/email/verification', paulo);
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    assert.equal(asked.body.queuedFor, paulo.email);
    assert.equal((await api('POST', '/account/email/verification', paulo)).status, 429, 'cooldown');
    await processDueNotifications();
    const [mail] = provider.sent;
    assert.equal(mail.to.email, paulo.email);
    assert.match(mail.subject, /Confirme seu e-mail/);
    const token = tokenFrom(mail);
    assert.ok(token.length >= 40);
    const stored = await UserModel.findById(paulo.id).select('+emailVerification');
    assert.notEqual(stored?.emailVerification?.tokenHash, token, 'only the hash is stored');

    const confirmed = await api('POST', '/account/email/confirm', null, { token });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal((await api('GET', '/account', paulo)).body.account.emailVerified, true);
    assert.equal((await api('POST', '/account/email/confirm', null, { token })).status, 400, 'single use');
    assert.equal((await api('POST', '/account/email/verification', paulo)).status, 409, 'already confirmed');
    await UserModel.updateOne({ _id: paulo.id }, { $set: { emailVerifiedAt: null } });
  });

  it('refuses expired and unknown tokens the same way', async () => {
    await UserModel.updateOne({ _id: paulo.id }, { $set: { emailVerifiedAt: null } });
    await NotificationModel.deleteMany({});
    await api('POST', '/account/email/verification', paulo);
    await processDueNotifications();
    const token = tokenFrom(provider.sent[0]);
    await UserModel.updateOne({ _id: paulo.id }, { $set: { 'emailVerification.expiresAt': new Date(Date.now() - 1) } });
    const expired = await api('POST', '/account/email/confirm', null, { token });
    const unknown = await api('POST', '/account/email/confirm', null, { token: 'x'.repeat(43) });
    assert.equal(expired.status, 400);
    assert.deepEqual(expired.body, unknown.body);
  });

  it('changes the e-mail only after the new inbox confirms, with the current password', async () => {
    const newEmail = 'maria.nova@notifications.test';
    assert.equal((await api('PUT', '/account/email', maria, { email: newEmail, currentPassword: 'errada' })).status, 403);
    assert.equal((await api('PUT', '/account/email', maria, { email: carlos.email, currentPassword: PASSWORD })).status, 409);
    assert.equal((await api('PUT', '/account/email', maria, { email: 'nao-e-email', currentPassword: PASSWORD })).status, 400);
    assert.equal((await api('PUT', '/account/email', maria, { email: newEmail, currentPassword: PASSWORD, userId: paulo.id })).status, 400);
    const changed = await api('PUT', '/account/email', maria, { email: newEmail, currentPassword: PASSWORD });
    assert.equal(changed.status, 202, JSON.stringify(changed.body));
    let account = (await api('GET', '/account', maria)).body.account;
    assert.equal(account.email, maria.email, 'the login e-mail is still the old one');
    assert.equal(account.pendingEmail, newEmail);

    // Ticket e-mails keep going to the confirmed address meanwhile.
    await openTicket(maria);
    await processDueNotifications();
    const verification = provider.sent.find((mail) => /novo e-mail/.test(mail.subject))!;
    assert.equal(verification.to.email, newEmail);
    assert.ok(provider.sent.filter((mail) => mail !== verification).every((mail) => mail.to.email === maria.email));

    assert.equal((await api('POST', '/account/email/confirm', null, { token: tokenFrom(verification) })).status, 200);
    account = (await api('GET', '/account', maria)).body.account;
    assert.equal(account.email, newEmail);
    assert.equal(account.pendingEmail, null);
    await UserModel.updateOne({ _id: maria.id }, { $set: { email: maria.email } });
  });

  it('keeps the demo accounts e-mail and refuses a change while e-mail is off', async () => {
    assert.equal((await api('PUT', '/account/email', demo, { email: 'mariana@notifications.test', currentPassword: PASSWORD })).body.code, 'DEMO_ACCOUNT');
    setEmailSettingsForTests({ enabled: false, provider });
    const off = await api('POST', '/account/email/verification', paulo);
    assert.equal(off.status, 409);
    assert.equal(off.body.code, 'EMAIL_DISABLED');
    const account = (await api('GET', '/account', paulo)).body.account;
    assert.equal(account.delivery.enabled, false);
  });

  it('updates only known preferences of the person', async () => {
    assert.equal((await api('PATCH', '/account/notification-preferences', maria, { ticketResolved: false })).status, 400, 'the resolution e-mail is not optional');
    assert.equal((await api('PATCH', '/account/notification-preferences', maria, {})).status, 400);
    const updated = await api('PATCH', '/account/notification-preferences', maria, { materialDelivered: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.account.preferences.materialDelivered, false);
    assert.equal((await api('GET', '/account', paulo)).body.account.preferences.materialDelivered, true);
  });
});

describe('providers', () => {
  async function fakeServer(handler: (body: Json, headers: Json, path: string) => { status: number; body: Json }) {
    const calls: { body: Json; headers: Json; path: string }[] = [];
    const fake = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ body, headers: req.headers, path: req.url ?? '' });
      const reply = handler(body, req.headers, req.url ?? '');
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => fake.once('listening', resolve));
    return { url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, calls, close: () => new Promise((resolve) => fake.close(resolve)) };
  }
  const message: OutgoingEmail = { to: { email: 'pessoa@exemplo.dev', name: 'Pessoa' }, subject: 'Assunto', html: '<p>Oi</p>', text: 'Oi', idempotencyKey: 'ticket-event:abc:123' };

  it('Mailpit: posts the message to its send API and classifies failures', async () => {
    let status = 200;
    const fake = await fakeServer(() => ({ status, body: status === 200 ? { ID: 'mp-1' } : { error: 'x' } }));
    try {
      const mailpit = mailpitProvider(fake.url, 'IT Helpdesk <helpdesk@helpdesk.local>');
      assert.deepEqual(await mailpit.send(message), { ok: true, id: 'mp-1' });
      assert.equal(fake.calls[0].path, '/api/v1/send');
      assert.deepEqual(fake.calls[0].body.From, { Email: 'helpdesk@helpdesk.local', Name: 'IT Helpdesk' });
      assert.deepEqual(fake.calls[0].body.To, [{ Email: 'pessoa@exemplo.dev', Name: 'Pessoa' }]);
      assert.equal(fake.calls[0].body.HTML, '<p>Oi</p>');
      status = 503;
      assert.equal(((await mailpit.send(message)) as Json).retryable, true);
      status = 400;
      assert.equal(((await mailpit.send(message)) as Json).retryable, false);
    } finally {
      await fake.close();
    }
    const unreachable = await mailpitProvider('http://127.0.0.1:9', 'helpdesk@helpdesk.local').send(message);
    assert.deepEqual(unreachable, { ok: false, retryable: true, reason: 'network' });
  });

  it('Resend: sends the idempotency key and treats 5xx and 429 as temporary', async () => {
    let status = 200;
    const fake = await fakeServer(() => ({ status, body: status === 200 ? { id: 're-1' } : { name: status === 429 ? 'rate_limit_exceeded' : status === 422 ? 'validation_error' : 'internal_server_error', message: 'x', statusCode: status } }));
    try {
      const resend = resendProvider('re_test_not_a_real_key', 'IT Helpdesk <helpdesk@empresa.dev>', fake.url);
      assert.deepEqual(await resend.send(message), { ok: true, id: 're-1' });
      assert.equal(fake.calls[0].path, '/emails');
      assert.equal(fake.calls[0].headers['idempotency-key'], 'ticket-event:abc:123');
      assert.deepEqual(fake.calls[0].body.to, ['Pessoa <pessoa@exemplo.dev>']);
      assert.equal(fake.calls[0].body.text, 'Oi');
      for (const [code, retryable] of [[500, true], [429, true], [422, false]] as const) {
        status = code;
        const result = (await resend.send(message)) as Json;
        assert.equal(result.ok, false);
        assert.equal(result.retryable, retryable, `status ${code}`);
      }
    } finally {
      await fake.close();
    }
  });
});

describe('Gmail provider (fake SMTP transport: no network, no real credentials)', () => {
  type Json = { [key: string]: any };
  function fakeGmail(failWith?: unknown) {
    const created: Json[] = [];
    const sent: Json[] = [];
    const provider = gmailProvider('helpdesk.remetente@gmail.com', 'abcdefghijklmnop', 'IT Helpdesk <ignorado@outro-dominio.dev>', (options) => {
      created.push(options);
      return { sendMail: async (mail) => { if (failWith) throw failWith; sent.push(mail); return { messageId: '<gmail-1@gmail.com>' }; } };
    });
    return { provider, created, sent };
  }
  const message: OutgoingEmail = { to: { email: 'pessoa@exemplo.dev', name: 'Pessoa' }, subject: 'Assunto', html: '<p>Oi</p>', text: 'Oi', idempotencyKey: 'ticket-event:abc:123' };

  it('connects to Gmail SMTP over TLS with the app password and sends as the Gmail account', async () => {
    const { provider, created, sent } = fakeGmail();
    assert.equal(provider.name, 'gmail');
    assert.deepEqual(await provider.send(message), { ok: true, id: '<gmail-1@gmail.com>' });
    assert.equal(created.length, 1, 'one transport, reused');
    assert.equal(created[0].host, GMAIL_SMTP.host);
    assert.equal(created[0].port, 465);
    assert.equal(created[0].secure, true);
    assert.deepEqual(created[0].auth, { user: 'helpdesk.remetente@gmail.com', pass: 'abcdefghijklmnop' });
    assert.ok(created[0].connectionTimeout && created[0].socketTimeout, 'timeouts are set');
    // Gmail sends as the authenticated account: the address comes from GMAIL_USER, the name from EMAIL_FROM.
    assert.deepEqual(sent[0].from, { name: 'IT Helpdesk', address: 'helpdesk.remetente@gmail.com' });
    assert.deepEqual(sent[0].to, { name: 'Pessoa', address: 'pessoa@exemplo.dev' });
    assert.equal(sent[0].subject, 'Assunto');
    assert.equal(sent[0].html, '<p>Oi</p>');
    assert.equal(sent[0].text, 'Oi');
    assert.equal(sent[0].headers['X-Helpdesk-Notification'], 'ticket-event:abc:123');
    await provider.send(message);
    assert.equal(sent[1].messageId, sent[0].messageId, 'the same notification keeps its Message-ID on every attempt');
    await provider.send({ ...message, idempotencyKey: 'ticket-event:other:123' });
    assert.notEqual(sent[2].messageId, sent[0].messageId);
  });

  it('retries temporary SMTP and network failures, not refused logins or rejected messages', async () => {
    const cases: [unknown, boolean, string][] = [
      [Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }), false, 'smtp_535'],
      [Object.assign(new Error('Too many login attempts'), { code: 'EAUTH', responseCode: 454 }), true, 'smtp_454'],
      [Object.assign(new Error('Service not available'), { responseCode: 421 }), true, 'smtp_421'],
      [Object.assign(new Error('Mailbox unavailable'), { code: 'EENVELOPE', responseCode: 550 }), false, 'smtp_550'],
      [Object.assign(new Error('No recipients'), { code: 'EENVELOPE' }), false, 'eenvelope'],
      [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }), true, 'econnection'],
      [Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' }), true, 'etimedout'],
    ];
    for (const [failure, retryable, reason] of cases) {
      assert.deepEqual(classifySmtpError(failure), { ok: false, retryable, reason }, reason);
      assert.deepEqual(await fakeGmail(failure).provider.send(message), { ok: false, retryable, reason });
    }
  });

  it('sends the resolution e-mail of the main flow, with the link to confirm or contest in the system', async () => {
    const { provider, sent } = fakeGmail();
    const requester = await createUser('Solicitante Gmail', 'solicitante', { email: 'solicitante.gmail@helpdesk-avaliacao.dev', verified: true });
    useEmail({ provider, allowlist: ['solicitante.gmail@helpdesk-avaliacao.dev'] });
    const ticket = await openTicket(requester, 'Monitor sem imagem');
    await setStatus(ticket.id, 'em_andamento');
    await setStatus(ticket.id, 'resolvido');
    assert.equal((await processDueNotifications()).sent, 3);
    const resolved = sent.find((mail) => /resolvido/.test(mail.subject));
    assert.ok(resolved);
    assert.equal(resolved.to.address, 'solicitante.gmail@helpdesk-avaliacao.dev', 'the confirmed e-mail stored for the requester');
    assert.ok(resolved.text.includes(`${APP_URL}/tickets/${ticket.id}`));
    assert.match(resolved.text, /responda se o problema foi resolvido/);
    assert.match(resolved.text, /avisar que o problema continua/);
    const row = await NotificationModel.findOne({ ticket: ticket.id, type: 'ticket_resolved' });
    assert.equal(row?.provider, 'gmail');
    assert.equal(row?.sentTo, 'solicitante.gmail@helpdesk-avaliacao.dev');
  });

  it('keeps the allowlist and reserved domains for Gmail outside production', async () => {
    const { provider, sent } = fakeGmail();
    useEmail({ provider, allowlist: [] });
    await openTicket(maria); // @notifications.test: reserved, never sent by a real provider
    const outside = await createUser('Fora da Lista', 'solicitante', { email: 'fora.da.lista@helpdesk-avaliacao.dev', verified: true });
    await openTicket(outside);
    await processDueNotifications();
    assert.equal(sent.length, 0);
    assert.deepEqual((await NotificationModel.find({ status: 'skipped' })).map((row) => row.skipReason).sort(), ['recipient_not_in_allowlist', 'reserved_address']);
  });

  it('builds a real RFC 822 message with Nodemailer (stream transport, no connection)', async () => {
    let raw = '';
    const provider = gmailProvider('helpdesk.remetente@gmail.com', 'abcdefghijklmnop', 'IT Helpdesk <helpdesk@helpdesk.local>', () => {
      const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
      return { sendMail: async (mail) => { const info = await stream.sendMail(mail); raw = (info.message as Buffer).toString(); return { messageId: info.messageId }; } };
    });
    const result = await provider.send({ ...message, subject: 'Seu pedido foi resolvido: confirme se deu certo', html: '<p>Olá, Pessoa.</p>', text: 'Olá, Pessoa.' });
    assert.equal(result.ok, true);
    assert.match(raw, /^From: IT Helpdesk <helpdesk\.remetente@gmail\.com>$/m);
    assert.match(raw, /^To: Pessoa <pessoa@exemplo\.dev>$/m);
    assert.match(raw, /^Message-ID: <[a-f0-9]{32}@it-helpdesk\.notification>$/m);
    assert.match(raw, /^X-Helpdesk-Notification: ticket-event:abc:123$/m);
    assert.match(raw, /^Subject: Seu pedido foi resolvido: confirme se deu certo$/m);
    assert.match(raw, /Content-Type: multipart\/alternative/);
    assert.match(raw, /Content-Type: text\/plain/);
    assert.match(raw, /Content-Type: text\/html/);
    assert.doesNotMatch(raw, /abcdefghijklmnop/, 'the app password never goes into the message');
  });

  it('refuses to start with EMAIL_PROVIDER=gmail but no Gmail credentials', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config/env.ts')"], {
      cwd: process.cwd(),
      env: { ...process.env, EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'gmail', GMAIL_USER: '', GMAIL_APP_PASSWORD: '' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /GMAIL_USER is required/);
    assert.match(result.stderr, /GMAIL_APP_PASSWORD/);
  });
});
