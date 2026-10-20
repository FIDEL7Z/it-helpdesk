import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { OPTIONAL_NOTIFICATIONS } from '../models/user.model';
import * as account from '../services/account.service';

const preferences = z.strictObject(Object.fromEntries(OPTIONAL_NOTIFICATIONS.map((key) => [key, z.boolean().optional()])) as Record<(typeof OPTIONAL_NOTIFICATIONS)[number], z.ZodOptional<z.ZodBoolean>>)
  .refine((input) => Object.values(input).some((value) => value !== undefined), { message: 'Nothing to update' });
const emailChange = z.strictObject({
  email: z.email().max(254),
  currentPassword: z.string().min(1).max(200),
});
const confirmation = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/, 'Invalid token') });

export async function show(req: Request, res: Response): Promise<void> {
  res.json({ account: await account.getAccount(getAuthenticatedUser(req)) });
}

export async function updatePreferences(req: Request, res: Response): Promise<void> {
  res.json({ account: await account.updatePreferences(getAuthenticatedUser(req), preferences.parse(req.body)) });
}

/** 202: the e-mail is queued, not sent yet. */
export async function requestVerification(req: Request, res: Response): Promise<void> {
  res.status(202).json(await account.requestVerification(getAuthenticatedUser(req)));
}

export async function changeEmail(req: Request, res: Response): Promise<void> {
  const { email, currentPassword } = emailChange.parse(req.body);
  res.status(202).json(await account.changeEmail(getAuthenticatedUser(req), email, currentPassword));
}

export async function cancelPendingEmail(req: Request, res: Response): Promise<void> {
  res.json({ account: await account.cancelPendingEmail(getAuthenticatedUser(req)) });
}

export async function confirmEmail(req: Request, res: Response): Promise<void> {
  res.json(await account.confirmEmail(confirmation.parse(req.body).token));
}
