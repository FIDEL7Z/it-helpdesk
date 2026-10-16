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
  createdAt: Date;
  updatedAt: Date;
}

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
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

export const UserModel = model<User>('User', userSchema);

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}
