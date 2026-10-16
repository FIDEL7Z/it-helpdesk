import type { Request, Response } from 'express';
import { z } from 'zod';
import { DATA_ORIGINS, resolveOriginFilter } from '../services/data-origin';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import * as dashboardService from '../services/dashboard.service';
import { getManagerDashboard, PERIODS } from '../services/manager.service';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '../models/ticket.model';

const id = z.string().regex(/^[a-f\d]{24}$/i);
const managerQuery = z.strictObject({
  inactivityDays: z.coerce.number().int().min(1).max(90).default(3),
  ageDays: z.coerce.number().int().min(1).max(365).default(7),
  period: z.enum(PERIODS).default('month'), dataOrigin: z.enum(DATA_ORIGINS).default('operational'),
  analystId: id.optional(), requesterId: id.optional(), category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(), status: z.enum(TICKET_STATUSES).optional(),
});

export async function getManager(req: Request, res: Response): Promise<void> {
  const query = managerQuery.parse(req.query);
  // The management view always names one origin (operational by default), never a mix.
  res.json({ dashboard: await getManagerDashboard({ ...query, dataOrigin: resolveOriginFilter(query.dataOrigin) ?? 'operational' }) });
}

// No parameters: the scope comes only from the authenticated user, never from the URL.
const summaryQuerySchema = z.strictObject({ dataOrigin: z.enum(DATA_ORIGINS).optional() });

export async function getSummary(req: Request, res: Response): Promise<void> {
  const { dataOrigin } = summaryQuerySchema.parse(req.query);
  const summary = await dashboardService.getDashboardSummary(getAuthenticatedUser(req), resolveOriginFilter(dataOrigin));

  res.json({ summary });
}
