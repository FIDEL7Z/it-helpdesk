import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { HttpError } from '../errors/http-error';
import { StockMovementModel, type LocationRef, type PersonRef, type StockMovementDocument } from '../models/inventory.model';
import { TicketModel } from '../models/ticket.model';
import { UserModel, type PublicUser } from '../models/user.model';
import { DEMO_EMAILS } from './data-origin';
import { resolveLocation } from './organization.service';

/**
 * Shared rules of the stock and asset ledger.
 *
 * Idempotency: every change carries an operationId chosen by the client. The first request with
 * a key records the movement; a repeated request with the same key, author and content gets the
 * same movement back (nothing is applied twice); the same key with another author or content is
 * refused. The key is unique in the ledger, so two concurrent repeats cannot both apply.
 */

export const isDuplicateKey = (error: unknown): error is { code: 11000; keyPattern?: Record<string, unknown> } =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
};

/** Fingerprint of what was asked, to recognize a genuine repeat of the same request. */
export const requestHash = (payload: unknown) => createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');

export async function replayOf(operationId: string, actor: PublicUser, hash: string): Promise<StockMovementDocument | null> {
  const existing = await StockMovementModel.findOne({ operationId });
  if (!existing) return null;
  if (!existing.actor.equals(actor.id) || existing.requestHash !== hash) {
    throw new HttpError(409, 'This operation key was already used for a different request', 'OPERATION_KEY_REUSED');
  }
  return existing;
}

export const actorFields = (actor: PublicUser) => ({
  actor: new Types.ObjectId(actor.id),
  actorSnapshot: { name: actor.name, role: actor.role },
  // Movements by the reserved fictitious accounts are demonstration data, like their tickets.
  dataOrigin: DEMO_EMAILS.has(actor.email) ? 'demo' as const : 'operational' as const,
  occurredAt: new Date(),
});

/** Optional references of a movement, validated: ticket, the person who received, where. */
export interface ReferenceInput {
  ticketId?: string | null;
  recipientId?: string | null;
  departmentId?: string | null;
  roomId?: string | null;
}

export async function resolveReferences(input: ReferenceInput): Promise<{ ticket: Types.ObjectId | null; recipient: PersonRef | null; location: LocationRef | null }> {
  let ticket: Types.ObjectId | null = null;
  if (input.ticketId) {
    if (!Types.ObjectId.isValid(input.ticketId)) throw new HttpError(400, 'Invalid ticket id');
    const found = await TicketModel.exists({ _id: input.ticketId });
    if (!found) throw new HttpError(400, 'Unknown ticket');
    ticket = found._id;
  }
  let recipient: PersonRef | null = null;
  if (input.recipientId) {
    if (!Types.ObjectId.isValid(input.recipientId)) throw new HttpError(400, 'Invalid recipient id');
    const user = await UserModel.findById(input.recipientId).select('name active');
    if (!user || user.active === false) throw new HttpError(400, 'Unknown or inactive recipient');
    recipient = { id: user._id, name: user.name };
  }
  const location = input.departmentId || input.roomId ? await resolveLocation(input.departmentId, input.roomId) : null;
  return { ticket, recipient, location };
}

/** Which key of a duplicate-key error was hit. */
export const duplicateKeyOf = (error: { keyPattern?: Record<string, unknown> }) => Object.keys(error.keyPattern ?? {});
