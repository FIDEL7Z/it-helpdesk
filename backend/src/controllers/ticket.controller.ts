import type { Request, Response } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions';
import { DATA_ORIGINS, resolveOriginFilter } from '../services/data-origin';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import * as incidentService from '../services/incident.service';
import {
  TICKET_CATEGORIES,
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '../models/ticket.model';
import { INTAKE_QUESTIONS } from '../services/intake';
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
  // Guided-form answers; checked against the question catalog in the service.
  intake: z.strictObject({
    answers: z.array(z.strictObject({ key: z.string().max(40), answer: z.string().max(400) })).max(10).default([]),
    articleId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid article id').optional(),
  }).optional(),
});

const listTicketsQuerySchema = z.object({
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  attention: z.enum(['high_unassigned', 'oldest', 'inactive', 'contested']).optional(),
  sort: z.enum(['newest', 'oldest']).optional(),
  inactivityDays: z.coerce.number().int().min(1).max(90).optional(),
  ageDays: z.coerce.number().int().min(1).max(365).optional(),
  pending: z.enum(['true']).optional().transform(value => value === 'true' ? true : undefined),
  assigneeId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  requesterId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  dataOrigin: z.enum(DATA_ORIGINS).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  assignee: z.enum(ticketService.ASSIGNEE_FILTERS).optional(),
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

/** Questions of the guided request form, by category (same catalog the API validates against). */
export function getIntakeQuestions(_req: Request, res: Response): void {
  res.json({ questions: INTAKE_QUESTIONS });
}

export async function listTickets(req: Request, res: Response): Promise<void> {
  const query = listTicketsQuerySchema.parse(req.query);
  const actor = getAuthenticatedUser(req);
  const result = await ticketService.listTickets({ ...query, dataOrigin: resolveOriginFilter(query.dataOrigin) }, actor);

  // The team sees which tickets are the main ticket of a shared incident (and how many people joined).
  if (can(actor.role, 'incidents:manage')) {
    const badges = await incidentService.badgesForTickets(result.tickets.map((ticket) => ticket.id));
    res.json({ ...result, tickets: result.tickets.map((ticket) => ({ ...ticket, incident: badges.get(ticket.id) ?? null })) });
    return;
  }
  res.json(result);
}

export async function getTicket(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const ticket = await ticketService.getTicket(id, getAuthenticatedUser(req));

  res.json({ ticket });
}

const mutationFields = { expectedRevision: z.number().int().min(0), reason: z.string().trim().min(5).max(1000).optional() };

const updateTicketSchema = z
  .strictObject({
    ...mutationFields,
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
  })
  .refine((input) => ['title', 'description', 'category', 'priority'].some(key => input[key as keyof typeof input] !== undefined), {
    message: 'Provide at least one field to update',
  });

// The cycle names the resolution being answered; the requester comes from the token.
const cycleField = { cycleId: z.number().int().min(1) };
const confirmSchema = z.strictObject(cycleField);
const contestSchema = z.strictObject({ ...cycleField, reason: z.string().trim().min(5).max(1000) });
const ratingSchema = z.strictObject({
  ...cycleField,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(ticketService.RATING_COMMENT_MAX).optional().transform((value) => value || undefined),
});

const changeStatusSchema = z.strictObject({
  ...mutationFields,
  status: z.enum(TICKET_STATUSES),
});

const assignTicketSchema = z.strictObject({
  ...mutationFields,
  assigneeId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid user id'),
});

export async function updateTicket(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { expectedRevision, reason, ...input } = updateTicketSchema.parse(req.body);
  const ticket = await ticketService.updateTicket(id, input, getAuthenticatedUser(req), expectedRevision, reason);

  res.json({ ticket });
}

export async function changeStatus(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { status, expectedRevision, reason } = changeStatusSchema.parse(req.body);
  const actor = getAuthenticatedUser(req);
  const ticket = await ticketService.changeStatus(id, status, actor, expectedRevision, reason);

  // Resolving the main ticket closes its shared incident. The ticket is already saved, so a failure
  // here must not turn the response into an error; reads reconcile a missed close (see incident.service).
  if (ticket.status === 'resolvido') {
    await incidentService.closeForResolvedTicket(ticket.id, actor).catch((error: unknown) => {
      console.error('Could not close the shared incident after resolving the ticket:', error);
    });
  }

  res.json({ ticket });
}

export async function assignTicket(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { assigneeId, expectedRevision, reason } = assignTicketSchema.parse(req.body);
  const ticket = await ticketService.assignTicket(id, assigneeId, getAuthenticatedUser(req), expectedRevision, reason);

  res.json({ ticket });
}

export async function confirmResolution(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { cycleId } = confirmSchema.parse(req.body);
  res.json({ ticket: await ticketService.confirmResolution(id, cycleId, getAuthenticatedUser(req)) });
}

export async function contestResolution(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { cycleId, reason } = contestSchema.parse(req.body);
  res.json({ ticket: await ticketService.contestResolution(id, cycleId, reason, getAuthenticatedUser(req)) });
}

export async function rateResolution(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { cycleId, rating, comment } = ratingSchema.parse(req.body);
  res.json({ ticket: await ticketService.rateResolution(id, cycleId, rating, comment, getAuthenticatedUser(req)) });
}
