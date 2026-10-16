import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { ticketMaterials } from '../services/ticket-materials.service';

const params = z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id') });

export async function getMaterials(req: Request, res: Response): Promise<void> {
  const { id } = params.parse(req.params);
  res.json({ materials: await ticketMaterials(id, getAuthenticatedUser(req)) });
}
