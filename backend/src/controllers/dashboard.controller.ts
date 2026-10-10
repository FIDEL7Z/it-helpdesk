import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { HttpError } from '../errors/http-error';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import * as dashboardService from '../services/dashboard.service';
import { getManagerDashboard, PERIODS } from '../services/manager.service';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '../models/ticket.model';

const id = z.string().regex(/^[a-f\d]{24}$/i);
const managerQuery = z.strictObject({
  inactivityDays: z.coerce.number().int().min(1).max(90).default(3),
  ageDays: z.coerce.number().int().min(1).max(365).default(7),
  period: z.enum(PERIODS).default('month'), dataOrigin: z.enum(['operational', 'demo', 'legacy']).default('operational'),
  analystId: id.optional(), requesterId: id.optional(), category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(), status: z.enum(TICKET_STATUSES).optional(),
});

export async function getManager(req: Request, res: Response): Promise<void> {
  const query = managerQuery.parse(req.query);
  if (query.dataOrigin !== 'operational' && (!env.DEMO_MODE || process.env.NODE_ENV === 'production')) throw new HttpError(403, 'Demonstration indicators are disabled');
  res.json({ dashboard: await getManagerDashboard(query) });
}

// No parameters: the scope comes only from the authenticated user, never from the URL.
const summaryQuerySchema = z.strictObject({ dataOrigin: z.enum(['operational', 'demo', 'legacy']).optional() });

export async function getSummary(req: Request, res: Response): Promise<void> {
  const { dataOrigin } = summaryQuerySchema.parse(req.query);
  const summary = await dashboardService.getDashboardSummary(getAuthenticatedUser(req), dataOrigin);

  res.json({ summary });
}
