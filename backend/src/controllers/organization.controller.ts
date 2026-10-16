import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { ORG_LIMITS } from '../models/organization.model';
import * as organization from '../services/organization.service';

const id = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const idParams = z.strictObject({ id });
const text = (max: number) => z.string().trim().min(1).max(max);
// Optional text: empty means "remove it".
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => (value ? value : value === undefined ? undefined : null));

const departmentCreate = z.strictObject({
  name: text(ORG_LIMITS.nameMax),
  code: z.string().trim().max(ORG_LIMITS.codeMax).regex(/^[A-Za-z0-9-]*$/, 'Use letters, digits or hyphens').nullable().optional().transform((value) => value || null),
  description: optionalText(ORG_LIMITS.descriptionMax),
});
const departmentUpdate = departmentCreate.partial().extend({ active: z.boolean().optional() })
  .refine((input) => Object.keys(input).length > 0, { message: 'Nothing to update' });

const roomFields = {
  name: text(ORG_LIMITS.nameMax),
  building: optionalText(ORG_LIMITS.buildingMax),
  floor: optionalText(ORG_LIMITS.floorMax),
  description: optionalText(ORG_LIMITS.descriptionMax),
};
const roomCreate = z.strictObject({ departmentId: id, ...roomFields });
const roomUpdate = z.strictObject({ ...roomFields, active: z.boolean() }).partial()
  .refine((input) => Object.keys(input).length > 0, { message: 'Nothing to update' });

const listQuery = z.strictObject({ includeInactive: z.enum(['true', 'false']).optional() });
const personLocation = z.strictObject({
  departmentId: id.nullable(),
  roomId: id.nullable(),
  jobTitle: optionalText(80),
});

export async function list(req: Request, res: Response): Promise<void> {
  const { includeInactive } = listQuery.parse(req.query);
  const actor = getAuthenticatedUser(req);
  const [departments, myLocation] = await Promise.all([
    organization.listOrganization(actor, includeInactive === 'true'),
    organization.myLocation(actor),
  ]);
  res.json({ departments, myLocation });
}

export async function createDepartment(req: Request, res: Response): Promise<void> {
  res.status(201).json({ department: await organization.createDepartment(departmentCreate.parse(req.body)) });
}

export async function updateDepartment(req: Request, res: Response): Promise<void> {
  const params = idParams.parse(req.params);
  res.json({ department: await organization.updateDepartment(params.id, departmentUpdate.parse(req.body)) });
}

export async function createRoom(req: Request, res: Response): Promise<void> {
  res.status(201).json({ room: await organization.createRoom(roomCreate.parse(req.body)) });
}

export async function updateRoom(req: Request, res: Response): Promise<void> {
  const params = idParams.parse(req.params);
  res.json({ room: await organization.updateRoom(params.id, roomUpdate.parse(req.body)) });
}

export async function listPeople(_req: Request, res: Response): Promise<void> {
  res.json({ people: await organization.listPeople() });
}

export async function setPersonLocation(req: Request, res: Response): Promise<void> {
  const params = idParams.parse(req.params);
  res.json({ person: await organization.setPersonLocation(params.id, personLocation.parse(req.body)) });
}
