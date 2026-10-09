import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import {
  TICKET_CATEGORIES,
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '../models/ticket.model';
import * as ticketService from '../services/ticket.service';

export const MAX_PAGE_SIZE = 50;

const titleSchema = z.string().trim().min(TICKET_LIMITS.titleMin).max(TICKET_LIMITS.titleMax);
const descriptionSchema = z
  .string()
  .trim()
  .min(TICKET_LIMITS.descriptionMin)
  .max(TICKET_LIMITS.descriptionMax);

const idParamsSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ticket id'),
});

// strictObject: unknown fields such as requester, status or history are rejected with 400.
const createTicketSchema = z.strictObject({
  title: titleSchema,
  description: descriptionSchema,
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).default('media'),
});

const listTicketsQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => value || undefined),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

export async function createTicket(req: Request, res: Response): Promise<void> {
  const input = createTicketSchema.parse(req.body);
  const ticket = await ticketService.createTicket(input, getAuthenticatedUser(req));

  res.status(201).json({ ticket });
}

export async function listTickets(req: Request, res: Response): Promise<void> {
  const query = listTicketsQuerySchema.parse(req.query);
  const result = await ticketService.listTickets(query, getAuthenticatedUser(req));

  res.json(result);
}

export async function getTicket(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const ticket = await ticketService.getTicket(id, getAuthenticatedUser(req));

  res.json({ ticket });
}
