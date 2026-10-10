import type { Request, Response } from 'express';
import { rolesWith } from '../auth/permissions';
import { UserModel, toPublicUser } from '../models/user.model';

/** IT team members (users that can be assigned to tickets), used to pick an assignee. */
export async function listItStaff(_req: Request, res: Response): Promise<void> {
  const users = await UserModel.find({ active: { $ne: false }, role: { $in: rolesWith('tickets:be-assigned') } }).sort({ name: 1 });

  res.json({ users: users.map(toPublicUser) });
}
