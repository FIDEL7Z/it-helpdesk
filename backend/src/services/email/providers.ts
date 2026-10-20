import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';

export interface OutgoingEmail {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
  /** Same key on every attempt of one notification: providers that support it drop duplicates. */
  idempotencyKey: string;
}

/** retryable: worth another attempt later (network, timeout, 429, 5xx). Otherwise the request itself is wrong. */
export type SendResult = { ok: true; id: string | null } | { ok: false; retryable: boolean; reason: string };

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingEmail): Promise<SendResult>;
}

const SEND_TIMEOUT_MS = 15_000;

/** "IT Helpdesk <helpdesk@x>" or "helpdesk@x". */
export function parseSender(from: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  if (match) return { email: match[2], ...(match[1] ? { name: match[1].replace(/^"|"$/g, '') } : {}) };
  return { email: from.trim() };
}

function classifyStatus(status: number | null | undefined, name: string): SendResult {
  const retryable = status === null || status === undefined || status === 429 || status >= 500;
  return { ok: false, retryable, reason: `${name}${status ? ` (${status})` : ''}`.slice(0, 120) };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mailpit (https://mailpit.axllent.org) is a local inbox: every message stays on this machine,
 * whatever the address. Uses its HTTP send API (v1.18+), so no SMTP library is needed.
 * Mailpit has no idempotency keys: a crash between sending and recording can repeat one message.
 */
export function mailpitProvider(baseUrl: string, from: string): EmailProvider {
  const sender = parseSender(from);
  return {
    name: 'mailpit',
    async send(message) {
      try {
        const response = await fetch(`${baseUrl}/api/v1/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          body: JSON.stringify({
            From: { Email: sender.email, Name: sender.name ?? '' },
            To: [{ Email: message.to.email, Name: message.to.name ?? '' }],
            Subject: message.subject,
            Text: message.text,
            HTML: message.html,
            Headers: { 'X-Helpdesk-Notification': message.idempotencyKey },
          }),
        });
        if (!response.ok) return classifyStatus(response.status, 'mailpit_error');
        const body = (await response.json().catch(() => ({}))) as { ID?: string };
        return { ok: true, id: body.ID ?? null };
      } catch (error) {
        return { ok: false, retryable: true, reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network' };
      }
    },
  };
}

/** Resend (https://resend.com): real delivery from a verified sender domain, with idempotency keys kept for 24 h. */
export function resendProvider(apiKey: string, from: string, baseUrl?: string): EmailProvider {
  const client = new Resend(apiKey, baseUrl ? { baseUrl } : undefined);
  return {
    name: 'resend',
    async send(message) {
      try {
        const { data, error } = await withTimeout(client.emails.send(
          {
            from,
            to: [message.to.name ? `${message.to.name.replace(/[<>"\r\n]/g, '')} <${message.to.email}>` : message.to.email],
            subject: message.subject,
            html: message.html,
            text: message.text,
          },
          { idempotencyKey: message.idempotencyKey },
        ), SEND_TIMEOUT_MS);
        if (error) return classifyStatus((error as { statusCode?: number | null }).statusCode, String(error.name ?? 'resend_error'));
        return { ok: true, id: data?.id ?? null };
      } catch (error) {
        // A timeout may still have reached Resend; the idempotency key makes the retry safe.
        return { ok: false, retryable: true, reason: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'network' };
      }
    },
  };
}

/** What the Gmail provider needs from a Nodemailer transport (tests pass a fake one). */
export interface SmtpTransport {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }>;
}
export type SmtpTransportFactory = (options: Record<string, unknown>) => SmtpTransport;

export const GMAIL_SMTP = Object.freeze({ host: 'smtp.gmail.com', port: 465, secure: true });

/**
 * SMTP errors: 4xx replies (421, 450, 451, 454) are temporary; 5xx replies and a refused login
 * (535) are not retried. No reply at all (connection, DNS, timeout) is temporary.
 */
export function classifySmtpError(error: unknown): SendResult {
  const failure = (error ?? {}) as { responseCode?: number; code?: string; message?: string };
  if (typeof failure.responseCode === 'number') {
    return { ok: false, retryable: failure.responseCode >= 400 && failure.responseCode < 500, reason: `smtp_${failure.responseCode}` };
  }
  if (failure.code === 'EAUTH' || failure.code === 'EENVELOPE' || failure.code === 'EMESSAGE') {
    return { ok: false, retryable: false, reason: failure.code.toLowerCase() };
  }
  return { ok: false, retryable: true, reason: failure.message === 'timeout' ? 'timeout' : failure.code ? failure.code.toLowerCase() : 'network' };
}

/**
 * Gmail as the sender, configured once by the owner: a Google account with 2-step verification
 * and an app password, both only in backend/.env. Nobody else signs in to Google. Gmail sends as
 * the authenticated account, so the address is always GMAIL_USER (EMAIL_FROM gives the name).
 * SMTP has no idempotency key: a crash between sending and recording can repeat a message; the
 * Message-ID is the same on every attempt of one notification, so the inbox sees it as one.
 */
export function gmailProvider(user: string, appPassword: string, from: string, createTransport: SmtpTransportFactory = (options) => nodemailer.createTransport(options)): EmailProvider {
  const transport = createTransport({
    ...GMAIL_SMTP,
    auth: { user, pass: appPassword },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  const name = parseSender(from).name ?? 'IT Helpdesk';
  return {
    name: 'gmail',
    async send(message) {
      try {
        const info = await withTimeout(transport.sendMail({
          from: { name, address: user },
          to: { name: message.to.name ?? '', address: message.to.email },
          subject: message.subject,
          html: message.html,
          text: message.text,
          messageId: `<${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 32)}@it-helpdesk.notification>`,
          headers: { 'X-Helpdesk-Notification': message.idempotencyKey },
        }), SEND_TIMEOUT_MS);
        return { ok: true, id: info.messageId ?? null };
      } catch (error) {
        return classifySmtpError(error);
      }
    },
  };
}
