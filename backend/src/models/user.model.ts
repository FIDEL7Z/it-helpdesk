import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/** solicitante: opens tickets. ti: works on tickets. gestor: manager with supervision and ticket operations. */
export const USER_ROLES = ['solicitante', 'ti', 'gestor'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface User {
  name: string;
  email: string;
  active: boolean;
  passwordHash: string;
  role: UserRole;
  /** Where the person usually works. Set only by people with org:manage, never by the person. */
  department?: Types.ObjectId | null;
  room?: Types.ObjectId | null;
  jobTitle?: string | null;
  /** Set when the person proved they read the current address. Notifications go only to confirmed addresses. */
  emailVerifiedAt?: Date | null;
  /** A new address waiting for confirmation; the login e-mail changes only after it is confirmed. */
  pendingEmail?: string | null;
  /** Hash of the single-use confirmation token, the address it confirms and its expiry. Never selected by default. */
  emailVerification?: { tokenHash: string; email: string; expiresAt: Date } | null;
  /** Optional ticket e-mails. The resolution e-mail (it asks for a confirmation) is always sent. */
  notificationPreferences?: NotificationPreferences;
  createdAt: Date;
  updatedAt: Date;
}

export const OPTIONAL_NOTIFICATIONS = ['ticketCreated', 'ticketStarted', 'ticketReopened', 'materialDelivered'] as const;
export type OptionalNotification = (typeof OPTIONAL_NOTIFICATIONS)[number];
export type NotificationPreferences = Record<OptionalNotification, boolean>;

export type UserDocument = HydratedDocument<User>;

/** Fields that are safe to send to clients. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

const userSchema = new Schema<User>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    // Excluded from queries by default; must be requested with .select('+passwordHash').
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: USER_ROLES, required: true },
    active: { type: Boolean, default: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    room: { type: Schema.Types.ObjectId, ref: 'Room', default: null },
    jobTitle: { type: String, trim: true, maxlength: 80, default: null },
    emailVerifiedAt: { type: Date, default: null },
    pendingEmail: { type: String, trim: true, lowercase: true, default: null },
    emailVerification: {
      type: new Schema({ tokenHash: { type: String, required: true }, email: { type: String, required: true }, expiresAt: { type: Date, required: true } }, { _id: false }),
      default: null,
      select: false,
    },
    notificationPreferences: {
      type: new Schema(Object.fromEntries(OPTIONAL_NOTIFICATIONS.map((key) => [key, { type: Boolean, default: true }])), { _id: false }),
      default: () => ({}),
    },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ 'emailVerification.tokenHash': 1 }, { sparse: true });

export const UserModel = model<User>('User', userSchema);

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}
