import type { Request, Response } from 'express';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middlewares/auth.middleware';
import { INVENTORY_LIMITS, MOVEMENT_TYPES, PRODUCT_TYPES, PRODUCT_UNITS, TRACKING_MODES, type StockMovementDocument } from '../models/inventory.model';
import * as catalog from '../services/catalog.service';
import { movementViews, listMovements } from '../services/movement.service';
import * as stock from '../services/stock.service';
import { StockMovementModel } from '../models/inventory.model';
import { HttpError } from '../errors/http-error';

export const id = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const idParams = z.strictObject({ id });
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => (value ? value : value === undefined ? undefined : null));
/** Idempotency key chosen by the client (a UUID); repeating it never applies the change twice. */
export const operationId = z.string().min(8).max(100).regex(/^[A-Za-z0-9:_-]+$/, 'Invalid operation key');
export const requiredReason = z.string().trim().min(INVENTORY_LIMITS.reasonMin).max(INVENTORY_LIMITS.reasonMax);
export const optionalReason = z.string().trim().max(INVENTORY_LIMITS.reasonMax).nullable().optional();
const quantity = z.number().int().min(1).max(INVENTORY_LIMITS.quantityMax);
export const references = {
  ticketId: id.nullable().optional(),
  recipientId: id.nullable().optional(),
  departmentId: id.nullable().optional(),
  roomId: id.nullable().optional(),
};

const attributes = z.record(z.string().max(40), z.union([z.string().max(120), z.number(), z.boolean(), z.null()])).optional();
const productCreate = z.strictObject({
  sku: z.string().trim().max(INVENTORY_LIMITS.skuMax).regex(/^[A-Za-z0-9._-]*$/, 'Use letters, digits, dots, hyphens or underscores').nullable().optional().transform((value) => value || null),
  name: z.string().trim().min(2).max(INVENTORY_LIMITS.nameMax),
  type: z.enum(PRODUCT_TYPES),
  brand: nullableText(INVENTORY_LIMITS.brandMax),
  model: nullableText(INVENTORY_LIMITS.modelMax),
  description: nullableText(INVENTORY_LIMITS.descriptionMax),
  attributes,
  unit: z.enum(PRODUCT_UNITS).optional(),
  minStock: z.number().int().min(0).max(INVENTORY_LIMITS.quantityMax).optional(),
  tracking: z.enum(TRACKING_MODES),
});
const productUpdate = productCreate.omit({ type: true, tracking: true }).partial().extend({
  active: z.boolean().optional(),
  expectedRevision: z.number().int().min(0),
});
const productQuery = z.strictObject({
  q: z.string().trim().max(100).optional(),
  type: z.enum(PRODUCT_TYPES).optional(),
  tracking: z.enum(TRACKING_MODES).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  belowMinimum: z.enum(['true']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const receipt = z.strictObject({ operationId, quantity, reason: optionalReason });
const reservation = z.strictObject({ operationId, quantity, reason: optionalReason, ...references, ticketId: id });
const cancel = z.strictObject({ operationId, reason: optionalReason });
const issue = z.strictObject({ operationId, quantity, reason: optionalReason, ...references, reservationId: id.nullable().optional() });
const returned = z.strictObject({ operationId, quantity, reason: optionalReason, ...references, condition: z.enum(['good', 'defective']) });
const adjustment = z.strictObject({ operationId, delta: z.number().int().min(-INVENTORY_LIMITS.quantityMax).max(INVENTORY_LIMITS.quantityMax).refine((v) => v !== 0, 'The delta cannot be zero'), reason: requiredReason });
const discard = z.strictObject({ operationId, quantity, reason: requiredReason });
const reversal = z.strictObject({ operationId, movementId: id, reason: requiredReason });
const movementQuery = z.strictObject({
  type: z.enum(MOVEMENT_TYPES).optional(),
  productId: id.optional(), assetId: id.optional(), ticketId: id.optional(), departmentId: id.optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function productTypes(_req: Request, res: Response): void {
  res.json({ types: catalog.PRODUCT_TYPE_CATALOG });
}

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = productQuery.parse(req.query);
  res.json(await catalog.listProducts({ ...query, belowMinimum: query.belowMinimum === 'true' }));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const params = idParams.parse(req.params);
  const product = await catalog.findProduct(params.id);
  if (product.tracking === 'quantity') await stock.currentLevels(product);
  const [view] = await catalog.productViews([await catalog.findProduct(params.id)]);
  const reservations = product.tracking === 'quantity' ? await movementViews(await stock.openReservations({ product: product._id })) : [];
  res.json({ product: view, openReservations: reservations });
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  res.status(201).json({ product: await catalog.createProduct(productCreate.parse(req.body), getAuthenticatedUser(req)) });
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const params = idParams.parse(req.params);
  res.json({ product: await catalog.updateProduct(params.id, productUpdate.parse(req.body), getAuthenticatedUser(req)) });
}

async function respond(res: Response, productId: string, result: { movement: StockMovementDocument; replayed: boolean }): Promise<void> {
  const [movement] = await movementViews([result.movement]);
  const [product] = await catalog.productViews([await catalog.findProduct(productId)]);
  res.status(result.replayed ? 200 : 201).json({ movement, product, replayed: result.replayed });
}

const productId = (req: Request) => idParams.parse({ id: req.params.id }).id;

export async function receive(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  await respond(res, id, await stock.receive(id, receipt.parse(req.body), getAuthenticatedUser(req)));
}

export async function reserve(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  await respond(res, id, await stock.reserve(id, reservation.parse(req.body), getAuthenticatedUser(req)));
}

export async function cancelReservation(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  const reservationId = z.strictObject({ id: idParams.shape.id, reservationId: idParams.shape.id }).parse(req.params).reservationId;
  await respond(res, id, await stock.cancelReservation(id, { ...cancel.parse(req.body), reservationId }, getAuthenticatedUser(req)));
}

export async function issueUnits(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  await respond(res, id, await stock.issue(id, issue.parse(req.body), getAuthenticatedUser(req)));
}

export async function returnUnits(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  await respond(res, id, await stock.returnUnits(id, returned.parse(req.body), getAuthenticatedUser(req)));
}

export async function adjust(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  await respond(res, id, await stock.adjust(id, adjustment.parse(req.body), getAuthenticatedUser(req)));
}

export async function discardUnits(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  await respond(res, id, await stock.discard(id, discard.parse(req.body), getAuthenticatedUser(req)));
}

export async function reverse(req: Request, res: Response): Promise<void> {
  const id = productId(req);
  await respond(res, id, await stock.reverse(id, reversal.parse(req.body), getAuthenticatedUser(req)));
}

export async function movements(req: Request, res: Response): Promise<void> {
  res.json(await listMovements(movementQuery.parse(req.query)));
}

export async function movement(req: Request, res: Response): Promise<void> {
  const params = idParams.parse(req.params);
  const found = await StockMovementModel.findById(params.id);
  if (!found) throw new HttpError(404, 'Movement not found');
  res.json({ movement: (await movementViews([found]))[0] });
}
