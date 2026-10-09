import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import * as authService from '../services/auth.service';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = loginSchema.parse(req.body);
  const result = await authService.login(email, password);

  res.json(result);
}

export function me(req: Request, res: Response): void {
  res.json({ user: getAuthenticatedUser(req) });
}
