import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { DATA_ORIGINS, resolveOriginFilter } from '../services/data-origin';
import { INCIDENT_LIMITS, INCIDENT_STATUSES } from '../models/incident.model';
import * as incidentService from '../services/incident.service';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const idParamsSchema = z.object({ id: objectIdSchema });

const titleSchema = z.string().trim().min(INCIDENT_LIMITS.titleMin).max(INCIDENT_LIMITS.titleMax);
const messageSchema = z.string().trim().min(INCIDENT_LIMITS.messageMin).max(INCIDENT_LIMITS.messageMax);
const expectedRevision = z.number().int().min(1);

// strictObject: the public text is the only thing the client can send; author, dates, status and
// the ticket reference come from the server.
const publishSchema = z.strictObject({ title: titleSchema, publicMessage: messageSchema });
const updateSchema = z
  .strictObject({ title: titleSchema.optional(), publicMessage: messageSchema.optional(), expectedRevision })
  .refine((input) => input.title !== undefined || input.publicMessage !== undefined, { message: 'Provide title or publicMessage' });
const closeSchema = z.strictObject({ resolutionMessage: messageSchema, expectedRevision });
const republishSchema = z.strictObject({ title: titleSchema, publicMessage: messageSchema, expectedRevision });
const manageQuerySchema = z.strictObject({
  status: z.enum(INCIDENT_STATUSES).optional(),
  dataOrigin: z.enum(DATA_ORIGINS).optional(),
});
const indicatorsQuerySchema = z.strictObject({ dataOrigin: z.enum(DATA_ORIGINS).optional() });
// Following takes no body: the user is the authenticated one, never an id sent by the client.
const noBodySchema = z.strictObject({});

export async function listActive(req: Request, res: Response): Promise<void> {
  res.json({ incidents: await incidentService.listActive(getAuthenticatedUser(req)) });
}

export async function listFollowed(req: Request, res: Response): Promise<void> {
  res.json({ incidents: await incidentService.listFollowed(getAuthenticatedUser(req)) });
}

export async function getPublic(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  res.json({ incident: await incidentService.getPublic(id, getAuthenticatedUser(req)) });
}

export async function getParticipation(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const incident = await incidentService.getPublic(id, getAuthenticatedUser(req));
  res.json({ following: incident.following, affectedCount: incident.affectedCount });
}

export async function follow(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  noBodySchema.parse(req.body ?? {});
  res.json({ incident: await incidentService.follow(id, getAuthenticatedUser(req)) });
}

export async function unfollow(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  res.json({ incident: await incidentService.unfollow(id, getAuthenticatedUser(req)) });
}

export async function listManaged(req: Request, res: Response): Promise<void> {
  const filters = manageQuerySchema.parse(req.query);
  res.json({ incidents: await incidentService.listManaged({ ...filters, dataOrigin: resolveOriginFilter(filters.dataOrigin) }) });
}

export async function indicators(req: Request, res: Response): Promise<void> {
  const { dataOrigin } = indicatorsQuerySchema.parse(req.query);
  res.json({ indicators: await incidentService.indicators(resolveOriginFilter(dataOrigin)) });
}

export async function updatePublicText(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { expectedRevision: revision, ...input } = updateSchema.parse(req.body);
  res.json({ incident: await incidentService.updatePublicText(id, input, revision, getAuthenticatedUser(req)) });
}

export async function close(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { resolutionMessage, expectedRevision: revision } = closeSchema.parse(req.body);
  res.json({ incident: await incidentService.closeManually(id, resolutionMessage, revision, getAuthenticatedUser(req)) });
}

export async function republish(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const { expectedRevision: revision, ...input } = republishSchema.parse(req.body);
  res.json({ incident: await incidentService.republish(id, input, revision, getAuthenticatedUser(req)) });
}

// ---------- Mounted under /api/tickets/:id/incident ----------

export async function getForTicket(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  res.json({ incident: await incidentService.getForTicket(id, getAuthenticatedUser(req)) });
}

export async function publish(req: Request, res: Response): Promise<void> {
  const { id } = idParamsSchema.parse(req.params);
  const input = publishSchema.parse(req.body);
  res.status(201).json({ incident: await incidentService.publish(id, input, getAuthenticatedUser(req)) });
}
