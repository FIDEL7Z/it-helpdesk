import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  APP_TIMEZONE: z.string().default('America/Fortaleza').refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'APP_TIMEZONE must be a valid IANA timezone'),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must have at least 32 characters'),
  // Accepts values like "15m", "8h" or "1d" (the format jsonwebtoken expects).
  JWT_EXPIRES_IN: z
    .templateLiteral([z.number().int().positive(), z.enum(['s', 'm', 'h', 'd'])])
    .default('8h'),
  // Comma-separated list of frontend origins allowed by CORS.
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

  // ---------- E-mail notifications (off by default: the helpdesk never depends on them) ----------
  EMAIL_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // mailpit: local inbox for development and evaluation (nothing leaves the machine). resend: real delivery.
  // gmail: real delivery through Gmail SMTP, from the owner's account (app password).
  EMAIL_PROVIDER: z.enum(['mailpit', 'resend', 'gmail']).default('mailpit'),
  EMAIL_FROM: z.string().min(3).default('IT Helpdesk <helpdesk@helpdesk.local>'),
  // Base of the links in e-mails (the frontend). Pages still require login.
  APP_PUBLIC_URL: z.url().default('http://localhost:5173').transform(value => value.replace(/\/+$/, '')),
  MAILPIT_URL: z.url().default('http://127.0.0.1:8025').transform(value => value.replace(/\/+$/, '')),
  RESEND_API_KEY: z.string().optional(),
  // The Gmail account that sends, and its 16-letter app password (Google shows it with spaces).
  GMAIL_USER: z.preprocess((value) => (value === '' ? undefined : value), z.email().optional()),
  GMAIL_APP_PASSWORD: z.string().optional().transform((value) => value?.replace(/\s+/g, '') || undefined),
  // ---------- Assistant (optional). Never blocks startup: a missing or invalid setting makes the ----------
  // assistant answer in an identified demonstration mode (checked in services/assistant/assistant.service.ts).
  // demo | gemini | cloudflare. Unset: cloudflare when AI_WORKER_* is set (older setups), demo otherwise.
  AI_PROVIDER: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().toLowerCase().optional()),
  // Gemini API, called directly by the backend. The key never leaves the backend.
  GEMINI_API_KEY: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().optional()),
  GEMINI_MODEL: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().optional()),
  // The Cloudflare Worker in ai-worker/.
  AI_WORKER_URL: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().optional()),
  AI_WORKER_KEY: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().optional()),
  // Outside production, Resend only delivers to these addresses or @domains (comma-separated).
  EMAIL_RECIPIENT_ALLOWLIST: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)),
}).superRefine((value, context) => {
  if (value.EMAIL_ENABLED && value.EMAIL_PROVIDER === 'resend' && !value.RESEND_API_KEY) {
    context.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend' });
  }
  if (value.EMAIL_ENABLED && value.EMAIL_PROVIDER === 'gmail') {
    if (!value.GMAIL_USER) context.addIssue({ code: 'custom', path: ['GMAIL_USER'], message: 'GMAIL_USER is required when EMAIL_PROVIDER=gmail' });
    if (!value.GMAIL_APP_PASSWORD) context.addIssue({ code: 'custom', path: ['GMAIL_APP_PASSWORD'], message: 'GMAIL_APP_PASSWORD (a Google app password) is required when EMAIL_PROVIDER=gmail' });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
