import { HttpError } from '../errors/http-error';
import { OPTIONAL_NOTIFICATIONS, UserModel, type NotificationPreferences, type PublicUser } from '../models/user.model';
import { comparePassword } from '../utils/password';
import { DEMO_EMAILS } from './data-origin';
import { emailSettings } from './email/settings';
import {
  NOTIFICATION_LIMITS, enqueueEmailVerification, hashToken, lastVerificationRequest, listOwnNotifications, type NotificationView,
} from './notification.service';

/**
 * The person's own e-mail and notification settings. Every function works on the authenticated
 * user only: there is no way to read or change another account here, and the address that
 * receives ticket e-mails is always the confirmed account e-mail, never one sent by the browser.
 */

export interface AccountView {
  name: string;
  email: string;
  emailVerified: boolean;
  pendingEmail: string | null;
  /** Fictitious demo accounts keep their documented login e-mail. */
  canChangeEmail: boolean;
  preferences: NotificationPreferences;
  delivery: { enabled: boolean; provider: string };
  notifications: NotificationView[];
}

const DEFAULT_PREFERENCES = Object.fromEntries(OPTIONAL_NOTIFICATIONS.map((key) => [key, true])) as NotificationPreferences;

async function loadUser(actor: PublicUser) {
  const user = await UserModel.findById(actor.id);
  if (!user?.active) throw new HttpError(401, 'User no longer exists');
  return user;
}

export async function getAccount(actor: PublicUser): Promise<AccountView> {
  const user = await loadUser(actor);
  const settings = emailSettings();
  const stored = user.notificationPreferences as Partial<NotificationPreferences> | undefined;
  return {
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
    pendingEmail: user.pendingEmail ?? null,
    canChangeEmail: !DEMO_EMAILS.has(user.email),
    preferences: Object.fromEntries(OPTIONAL_NOTIFICATIONS.map((key) => [key, stored?.[key] ?? DEFAULT_PREFERENCES[key]])) as NotificationPreferences,
    delivery: { enabled: settings.enabled, provider: settings.provider.name },
    notifications: await listOwnNotifications(user.id),
  };
}

export async function updatePreferences(actor: PublicUser, changes: Partial<NotificationPreferences>): Promise<AccountView> {
  const set = Object.fromEntries(Object.entries(changes).map(([key, value]) => [`notificationPreferences.${key}`, value]));
  await UserModel.updateOne({ _id: actor.id, active: true }, { $set: set });
  return getAccount(actor);
}

function assertEmailOn(): void {
  if (!emailSettings().enabled) throw new HttpError(409, 'E-mail delivery is turned off on this server', 'EMAIL_DISABLED');
}

async function assertCooldown(userId: Parameters<typeof lastVerificationRequest>[0]): Promise<void> {
  const last = await lastVerificationRequest(userId);
  if (last && Date.now() - last.getTime() < NOTIFICATION_LIMITS.verificationCooldownMs) {
    throw new HttpError(429, 'A confirmation e-mail was requested a moment ago. Wait a minute before asking again', 'VERIFICATION_COOLDOWN');
  }
}

/** Queues a confirmation for the pending address, or for the current one while it is not confirmed. */
export async function requestVerification(actor: PublicUser): Promise<{ queuedFor: string }> {
  assertEmailOn();
  const user = await loadUser(actor);
  const target = user.pendingEmail ?? (user.emailVerifiedAt ? null : user.email);
  if (!target) throw new HttpError(409, 'This e-mail is already confirmed', 'ALREADY_VERIFIED');
  await assertCooldown(user._id);
  await enqueueEmailVerification(user._id, target);
  return { queuedFor: target };
}

/**
 * The new address only becomes the login and notification e-mail after it is confirmed from its
 * own inbox. Requires the current password, so an unattended session cannot redirect e-mails.
 */
export async function changeEmail(actor: PublicUser, newEmail: string, currentPassword: string): Promise<{ queuedFor: string }> {
  assertEmailOn();
  const user = await UserModel.findById(actor.id).select('+passwordHash');
  if (!user?.active) throw new HttpError(401, 'User no longer exists');
  if (DEMO_EMAILS.has(user.email)) throw new HttpError(403, 'Demo accounts keep their documented e-mail', 'DEMO_ACCOUNT');
  if (!(await comparePassword(currentPassword, user.passwordHash))) throw new HttpError(403, 'Current password is incorrect', 'INVALID_PASSWORD');
  const email = newEmail.trim().toLowerCase();
  if (email === user.email) throw new HttpError(400, 'This is already your e-mail', 'SAME_EMAIL');
  if (await UserModel.exists({ _id: { $ne: user._id }, email })) throw new HttpError(409, 'This e-mail cannot be used', 'EMAIL_UNAVAILABLE');
  await assertCooldown(user._id);
  await UserModel.updateOne({ _id: user._id }, { $set: { pendingEmail: email, emailVerification: null } });
  await enqueueEmailVerification(user._id, email);
  return { queuedFor: email };
}

export async function cancelPendingEmail(actor: PublicUser): Promise<AccountView> {
  await UserModel.updateOne({ _id: actor.id }, { $set: { pendingEmail: null, emailVerification: null } });
  return getAccount(actor);
}

/**
 * Confirms from the link in the e-mail (no login needed: the single-use token proves access to
 * that inbox). Invalid, expired, used or superseded tokens all answer the same way.
 */
export async function confirmEmail(token: string): Promise<{ email: string }> {
  const invalid = () => new HttpError(400, 'This confirmation link is invalid or expired', 'INVALID_TOKEN');
  const user = await UserModel.findOne({ 'emailVerification.tokenHash': hashToken(token) }).select('+emailVerification');
  const verification = user?.emailVerification;
  if (!user?.active || !verification || verification.expiresAt.getTime() <= Date.now()) throw invalid();
  const target = verification.email;
  if (target !== user.email && target !== user.pendingEmail) throw invalid();
  if (target !== user.email && await UserModel.exists({ _id: { $ne: user._id }, email: target })) {
    throw new HttpError(409, 'This e-mail cannot be used', 'EMAIL_UNAVAILABLE');
  }
  // Single use: the update only matches while this exact token is still stored.
  try {
    const result = await UserModel.updateOne(
      { _id: user._id, 'emailVerification.tokenHash': verification.tokenHash },
      { $set: { email: target, emailVerifiedAt: new Date(), pendingEmail: null, emailVerification: null } },
    );
    if (result.modifiedCount !== 1) throw invalid();
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new HttpError(409, 'This e-mail cannot be used', 'EMAIL_UNAVAILABLE');
    throw error;
  }
  return { email: target };
}
