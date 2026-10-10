import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import * as dashboardService from '../services/dashboard.service';
import { getManagerDashboard, PERIODS } from '../services/manager.service';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '../models/ticket.model';

const id = z.string().regex(/^[a-f\d]{24}$/i);
const managerQuery = z.strictObject({
  period: z.enum(PERIODS).default('month'), dataOrigin: z.enum(['operational', 'demo', 'legacy']).default('operational'),
  analystId: id.optional(), requesterId: id.optional(), category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(), status: z.enum(TICKET_STATUSES).optional(),
});

export async function getManager(req: Request, res: Response): Promise<void> {
  res.json({ dashboard: await getManagerDashboard(managerQuery.parse(req.query)) });
}

// No parameters: the scope comes only from the authenticated user, never from the URL.
const summaryQuerySchema = z.strictObject({ dataOrigin: z.enum(['operational', 'demo', 'legacy']).optional() });

export async function getSummary(req: Request, res: Response): Promise<void> {
  const { dataOrigin } = summaryQuerySchema.parse(req.query);
  const summary = await dashboardService.getDashboardSummary(getAuthenticatedUser(req), dataOrigin);

  res.json({ summary });
}
