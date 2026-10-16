import { Types } from 'mongoose';
import { HttpError } from '../errors/http-error';
import {
  ProductModel,
  StockMovementModel,
  type ProductDocument,
  type QuantityMovementType,
  type StockLevels,
  type StockMovement,
  type StockMovementDocument,
} from '../models/inventory.model';
import type { PublicUser } from '../models/user.model';
import { findProduct } from './catalog.service';
import { actorFields, duplicateKeyOf, isDuplicateKey, replayOf, requestHash, resolveReferences, type ReferenceInput } from './ledger';

/**
 * Stock counted by quantity.
 *
 * Levels: onHand = usable units in the store room (reserved ones included); reserved = units held
 * for a ticket; available = onHand − reserved (what can still be reserved or delivered);
 * defective = units returned broken, kept apart and never available. None of them goes below zero.
 * Units delivered to people or installed are not stock any more: they are counted from the ledger.
 *
 * Concurrency without multi-document transactions: each movement takes the next sequence of its
 * product, and (product, sequence) is unique. Two technicians taking the last mouse both read
 * sequence N and try to write N+1; only one insert succeeds, the other re-reads the new levels and
 * gets "insufficient stock". The movement is the commit; product.stock is a projection of the
 * last movement and is repaired from the ledger when it lags behind.
 */

const MAX_ATTEMPTS = 8;

async function latestMovement(product: Types.ObjectId): Promise<StockMovementDocument | null> {
  return StockMovementModel.findOne({ kind: 'quantity', product }).sort({ sequence: -1 });
}

/** Levels and version, taken from the ledger when the projection lags behind (interrupted write). */
export async function currentLevels(product: ProductDocument): Promise<{ levels: StockLevels; version: number }> {
  const last = await latestMovement(product._id);
  if (last && last.sequence > product.stock.version) {
    const levels = pickLevels(last.after);
    await ProductModel.updateOne({ _id: product._id, 'stock.version': { $lt: last.sequence } }, { $set: { stock: { ...levels, version: last.sequence } } });
    return { levels, version: last.sequence };
  }
  return { levels: pickLevels(product.stock), version: product.stock.version };
}

const pickLevels = (value: unknown): StockLevels => {
  const source = value as Partial<StockLevels>;
  return { onHand: source.onHand ?? 0, reserved: source.reserved ?? 0, defective: source.defective ?? 0 };
};

function assertLevels(levels: StockLevels): void {
  if (levels.reserved < 0 || levels.defective < 0 || levels.onHand < 0) throw new HttpError(409, 'The operation would leave a negative balance', 'NEGATIVE_BALANCE');
  if (levels.onHand - levels.reserved < 0) throw new HttpError(409, 'Not enough available units', 'INSUFFICIENT_STOCK');
}

type Plan = { after: StockLevels; quantity: number; fields?: Partial<StockMovement> };

interface RecordInput {
  productId: string;
  type: QuantityMovementType;
  operationId: string;
  payload: Record<string, unknown>;
  actor: PublicUser;
  /** Runs against the current levels; throws a business error or returns the new levels. */
  plan: (levels: StockLevels, product: ProductDocument) => Promise<Plan>;
  allowInactive?: boolean;
}

export async function recordQuantity(input: RecordInput): Promise<{ movement: StockMovementDocument; replayed: boolean }> {
  const hash = requestHash({ type: input.type, productId: input.productId, ...input.payload });
  const replay = await replayOf(input.operationId, input.actor, hash);
  if (replay) return { movement: replay, replayed: true };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const product = await findProduct(input.productId);
    if (product.tracking !== 'quantity') throw new HttpError(400, 'This product is tracked by asset tag; use the asset operations', 'TRACKING_MISMATCH');
    if (!product.active && !input.allowInactive) throw new HttpError(409, 'This product is inactive', 'PRODUCT_INACTIVE');
    const { levels, version } = await currentLevels(product);
    const plan = await input.plan(levels, product);
    assertLevels(plan.after);
    let movement: StockMovementDocument;
    try {
      movement = await StockMovementModel.create({
        kind: 'quantity', type: input.type, product: product._id, asset: null, sequence: version + 1, quantity: plan.quantity,
        before: { ...levels }, after: { ...plan.after }, ...actorFields(input.actor), operationId: input.operationId, requestHash: hash,
        reason: null, ticket: null, recipient: null, location: null, fromLocation: null, condition: null, closes: null, reverses: null,
        ...plan.fields,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const keys = duplicateKeyOf(error);
      if (keys.includes('operationId')) {
        const repeated = await replayOf(input.operationId, input.actor, hash);
        if (repeated) return { movement: repeated, replayed: true };
      }
      if (keys.includes('closes')) throw new HttpError(409, 'This reservation was already closed', 'RESERVATION_CLOSED');
      if (keys.includes('reverses')) throw new HttpError(409, 'This movement was already reversed', 'ALREADY_REVERSED');
      continue; // Someone else took this sequence: read the new levels and decide again.
    }
    await ProductModel.updateOne({ _id: product._id, 'stock.version': { $lt: movement.sequence } }, { $set: { stock: { ...plan.after, version: movement.sequence } } });
    return { movement, replayed: false };
  }
  throw new HttpError(409, 'The stock of this product is changing right now. Try again', 'STOCK_BUSY');
}

// ---------- Operations ----------

export interface QuantityInput extends ReferenceInput {
  operationId: string;
  quantity: number;
  reason?: string | null;
}

const reasonOf = (input: { reason?: string | null }) => input.reason?.trim() || null;

/** Units arriving at the store room. */
export function receive(productId: string, input: QuantityInput, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'receipt', operationId: input.operationId, payload: { ...input }, actor,
    plan: async (levels) => ({ after: { ...levels, onHand: levels.onHand + input.quantity }, quantity: input.quantity, fields: { reason: reasonOf(input) } }),
  });
}

/** Holds units for a ticket: they stop being available but stay in the store room. */
export function reserve(productId: string, input: QuantityInput & { ticketId: string }, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'reserve', operationId: input.operationId, payload: { ...input }, actor,
    plan: async (levels) => {
      if (levels.onHand - levels.reserved < input.quantity) throw new HttpError(409, 'Not enough available units', 'INSUFFICIENT_STOCK');
      const refs = await resolveReferences(input);
      return { after: { ...levels, reserved: levels.reserved + input.quantity }, quantity: input.quantity, fields: { reason: reasonOf(input), ...refs } };
    },
  });
}

async function openReservation(productId: Types.ObjectId, reservationId: string): Promise<StockMovementDocument> {
  if (!Types.ObjectId.isValid(reservationId)) throw new HttpError(400, 'Invalid reservation id');
  const reservation = await StockMovementModel.findOne({ _id: reservationId, type: 'reserve', product: productId });
  if (!reservation) throw new HttpError(404, 'Reservation not found');
  if (await StockMovementModel.exists({ closes: reservation._id })) throw new HttpError(409, 'This reservation was already closed', 'RESERVATION_CLOSED');
  return reservation;
}

export function cancelReservation(productId: string, input: { operationId: string; reservationId: string; reason?: string | null }, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'reservation_cancel', operationId: input.operationId, payload: { ...input }, actor, allowInactive: true,
    plan: async (levels, product) => {
      const reservation = await openReservation(product._id, input.reservationId);
      return {
        after: { ...levels, reserved: levels.reserved - reservation.quantity }, quantity: reservation.quantity,
        fields: { reason: reasonOf(input), closes: reservation._id, ticket: reservation.ticket, location: reservation.location },
      };
    },
  });
}

/**
 * Physical delivery: units leave the store room. From a reservation, the reserved units are
 * delivered (and the reservation closes); otherwise it needs enough available units.
 * Never changes the ticket status: delivering and resolving are separate decisions.
 */
export function issue(productId: string, input: QuantityInput & { reservationId?: string | null }, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'issue', operationId: input.operationId, payload: { ...input }, actor,
    plan: async (levels, product) => {
      const refs = await resolveReferences(input);
      if (input.reservationId) {
        const reservation = await openReservation(product._id, input.reservationId);
        return {
          after: { ...levels, onHand: levels.onHand - reservation.quantity, reserved: levels.reserved - reservation.quantity },
          quantity: reservation.quantity,
          fields: { reason: reasonOf(input), ...refs, ticket: refs.ticket ?? reservation.ticket, closes: reservation._id },
        };
      }
      if (levels.onHand - levels.reserved < input.quantity) throw new HttpError(409, 'Not enough available units', 'INSUFFICIENT_STOCK');
      return { after: { ...levels, onHand: levels.onHand - input.quantity }, quantity: input.quantity, fields: { reason: reasonOf(input), ...refs } };
    },
  });
}

/** Units coming back: in good condition they are available again; broken ones are kept apart. */
export function returnUnits(productId: string, input: QuantityInput & { condition: 'good' | 'defective' }, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'return', operationId: input.operationId, payload: { ...input }, actor, allowInactive: true,
    plan: async (levels) => ({
      after: input.condition === 'good' ? { ...levels, onHand: levels.onHand + input.quantity } : { ...levels, defective: levels.defective + input.quantity },
      quantity: input.quantity,
      fields: { reason: reasonOf(input), condition: input.condition, ...(await resolveReferences(input)) },
    }),
  });
}

/** Inventory count correction (inventory:adjust): a signed delta on the usable units, with a reason. */
export function adjust(productId: string, input: { operationId: string; delta: number; reason: string }, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'adjustment', operationId: input.operationId, payload: { ...input }, actor, allowInactive: true,
    plan: async (levels) => {
      const after = { ...levels, onHand: levels.onHand + input.delta };
      if (after.onHand < levels.reserved) throw new HttpError(409, 'The adjustment would leave less units than are reserved', 'BELOW_RESERVED');
      return { after, quantity: Math.abs(input.delta), fields: { reason: input.reason.trim() } };
    },
  });
}

/** Disposal of defective units (inventory:adjust). */
export function discard(productId: string, input: { operationId: string; quantity: number; reason: string }, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'discard', operationId: input.operationId, payload: { ...input }, actor, allowInactive: true,
    plan: async (levels) => {
      if (levels.defective < input.quantity) throw new HttpError(409, 'There are not that many defective units', 'NEGATIVE_BALANCE');
      return { after: { ...levels, defective: levels.defective - input.quantity }, quantity: input.quantity, fields: { reason: input.reason.trim() } };
    },
  });
}

const REVERSIBLE: QuantityMovementType[] = ['receipt', 'issue', 'return', 'adjustment', 'discard'];

/**
 * Compensates a wrong entry (inventory:adjust): applies the opposite of what it changed and points
 * to it. The original stays in the ledger; a movement is reversed at most once. Reservations are
 * cancelled, not reversed; a delivery that closed a reservation is corrected with a return.
 */
export function reverse(productId: string, input: { operationId: string; movementId: string; reason: string }, actor: PublicUser) {
  return recordQuantity({
    productId, type: 'reversal', operationId: input.operationId, payload: { ...input }, actor, allowInactive: true,
    plan: async (levels, product) => {
      if (!Types.ObjectId.isValid(input.movementId)) throw new HttpError(400, 'Invalid movement id');
      const original = await StockMovementModel.findOne({ _id: input.movementId, product: product._id, kind: 'quantity' });
      if (!original) throw new HttpError(404, 'Movement not found');
      if (!REVERSIBLE.includes(original.type as QuantityMovementType) || original.closes) throw new HttpError(409, 'This movement cannot be reversed', 'NOT_REVERSIBLE');
      if (await StockMovementModel.exists({ reverses: original._id })) throw new HttpError(409, 'This movement was already reversed', 'ALREADY_REVERSED');
      const before = pickLevels(original.before);
      const changed = pickLevels(original.after);
      const after = {
        onHand: levels.onHand - (changed.onHand - before.onHand),
        reserved: levels.reserved - (changed.reserved - before.reserved),
        defective: levels.defective - (changed.defective - before.defective),
      };
      return { after, quantity: original.quantity, fields: { reason: input.reason.trim(), reverses: original._id, ticket: original.ticket } };
    },
  });
}

/** Reservations of a ticket (or product) that were neither delivered nor cancelled. */
export async function openReservations(filter: { ticket?: Types.ObjectId; product?: Types.ObjectId }): Promise<StockMovementDocument[]> {
  const reservations = await StockMovementModel.find({ type: 'reserve', ...filter }).sort({ occurredAt: 1 });
  const closed = new Set((await StockMovementModel.find({ closes: { $in: reservations.map((r) => r._id) } }).select('closes')).map((m) => m.closes!.toString()));
  return reservations.filter((reservation) => !closed.has(reservation.id));
}
