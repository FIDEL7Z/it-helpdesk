import { env } from '../../config/env';
import { gmailProvider, mailpitProvider, resendProvider, type EmailProvider } from './providers';

export interface EmailSettings {
  enabled: boolean;
  provider: EmailProvider;
  /** Frontend base for links. */
  appUrl: string;
  /** Outside production, real providers deliver only to these addresses or @domains. */
  allowlist: string[];
  production: boolean;
  timezone: string;
}

let fromEnv: EmailSettings | null = null;
let override: Partial<EmailSettings> | null = null;

function build(): EmailSettings {
  const provider = env.EMAIL_PROVIDER === 'resend'
    ? resendProvider(env.RESEND_API_KEY ?? 'missing', env.EMAIL_FROM)
    : env.EMAIL_PROVIDER === 'gmail'
      ? gmailProvider(env.GMAIL_USER ?? 'missing@gmail.com', env.GMAIL_APP_PASSWORD ?? 'missing', env.EMAIL_FROM)
      : mailpitProvider(env.MAILPIT_URL, env.EMAIL_FROM);
  return {
    enabled: env.EMAIL_ENABLED,
    provider,
    appUrl: env.APP_PUBLIC_URL,
    allowlist: env.EMAIL_RECIPIENT_ALLOWLIST,
    production: process.env.NODE_ENV === 'production',
    timezone: env.APP_TIMEZONE,
  };
}

export function emailSettings(): EmailSettings {
  fromEnv ??= build();
  return override ? { ...fromEnv, ...override } : fromEnv;
}

/** Tests replace the provider or turn e-mail on and off without touching the environment. */
export function setEmailSettingsForTests(settings: Partial<EmailSettings> | null): void {
  override = settings;
}
