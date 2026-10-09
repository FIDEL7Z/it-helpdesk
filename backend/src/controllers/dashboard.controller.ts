import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import * as dashboardService from '../services/dashboard.service';

// No parameters: the scope comes only from the authenticated user, never from the URL.
const summaryQuerySchema = z.strictObject({});

export async function getSummary(req: Request, res: Response): Promise<void> {
  summaryQuerySchema.parse(req.query);
  const summary = await dashboardService.getDashboardSummary(getAuthenticatedUser(req));

  res.json({ summary });
}
