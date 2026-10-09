import type { Request, Response } from 'express';
import { UserModel, toPublicUser } from '../models/user.model';

/** IT team members, used to pick a ticket assignee. */
export async function listItStaff(_req: Request, res: Response): Promise<void> {
  const users = await UserModel.find({ role: 'ti' }).sort({ name: 1 });

  res.json({ users: users.map(toPublicUser) });
}
