import { Types } from 'mongoose';
import { HttpError } from '../errors/http-error';
import {
  AssetModel,
  ProductModel,
  StockMovementModel,
  type AssetDocument,
  type AssetMovementType,
  type AssetState,
  type AssetStatus,
  type StockMovementDocument,
} from '../models/inventory.model';
import { TicketModel } from '../models/ticket.model';
import type { PublicUser } from '../models/user.model';
import { findProduct } from './catalog.service';
import { actorFields, duplicateKeyOf, isDuplicateKey, replayOf, requestHash, resolveReferences, type ReferenceInput } from './ledger';
import { toLocationView, type LocationView } from './organization.service';

/**
 * Equipment tracked one by one, by asset tag. The current state (status, place, holder, ticket it
 * is reserved for) is a projection of the asset's own ledger, like the stock of a product: each
 * change takes the next sequence of the asset, so two concurrent changes cannot both apply.
 *
 * - available: in the store room, ready to be delivered;
 * - reserved: held for a ticket;
 * - in_use: installed or with a person, at a department and room;
 * - in_maintenance / defective: out of use; where it was stays in the movement;
 * - retired: written off (inventory:adjust). Final.
 */
const TRANSITIONS: Record<Exclude<AssetMovementType, 'asset_register'>, { from: AssetStatus[]; to: AssetStatus }> = {
  asset_reserve: { from: ['available'], to: 'reserved' },
  asset_reservation_cancel: { from: ['reserved'], to: 'available' },
  asset_assign: { from: ['available', 'reserved', 'in_maintenance'], to: 'in_use' },
  asset_transfer: { from: ['in_use'], to: 'in_use' },
  asset_return: { from: ['in_use', 'in_maintenance', 'reserved'], to: 'available' },
  asset_maintenance: { from: ['available', 'reserved', 'in_use', 'defective'], to: 'in_maintenance' },
  asset_defective: { from: ['available', 'reserved', 'in_use', 'in_maintenance'], to: 'defective' },
  asset_retire: { from: ['available', 'reserved', 'in_use', 'in_maintenance', 'defective'], to: 'retired' },
};
export type AssetAction = keyof typeof TRANSITIONS;

const MAX_ATTEMPTS = 8;

const stateOf = (source: Partial<AssetState>): AssetState => ({
  status: source.status as AssetStatus, location: source.location ?? null, holder: source.holder ?? null, ticket: source.ticket ?? null,
});

async function currentState(asset: AssetDocument): Promise<{ state: AssetState; version: number }> {
  const last = await StockMovementModel.findOne({ kind: 'asset', asset: asset._id }).sort({ sequence: -1 });
  if (last && last.sequence > asset.version) {
    const state = stateOf(last.after as Partial<AssetState>);
    await AssetModel.updateOne({ _id: asset._id, version: { $lt: last.sequence } }, { $set: { ...state, version: last.sequence } });
    return { state, version: last.sequence };
  }
  return { state: stateOf(asset), version: asset.version };
}

async function findAsset(id: string): Promise<AssetDocument> {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid asset id');
  const asset = await AssetModel.findById(id);
  if (!asset) throw new HttpError(404, 'Asset not found');
  return asset;
}

type Plan = { after: AssetState; fields?: Record<string, unknown> };

async function recordAsset(input: {
  assetId: string; type: AssetMovementType; operationId: string; payload: Record<string, unknown>; actor: PublicUser;
  plan: (state: AssetState, asset: AssetDocument) => Promise<Plan>;
}): Promise<{ movement: StockMovementDocument; replayed: boolean }> {
  const hash = requestHash({ type: input.type, assetId: input.assetId, ...input.payload });
  const replay = await replayOf(input.operationId, input.actor, hash);
  if (replay) return { movement: replay, replayed: true };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const asset = await findAsset(input.assetId);
    const { state, version } = await currentState(asset);
    const plan = await input.plan(state, asset);
    let movement: StockMovementDocument;
    try {
      movement = await StockMovementModel.create({
        kind: 'asset', type: input.type, product: asset.product, asset: asset._id, sequence: version + 1, quantity: 1,
        before: { ...state }, after: { ...plan.after }, ...actorFields(input.actor), operationId: input.operationId, requestHash: hash,
        reason: null, ticket: null, recipient: null, location: null, fromLocation: state.location, condition: null, closes: null, reverses: null,
        ...plan.fields,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      if (duplicateKeyOf(error).includes('operationId')) {
        const repeated = await replayOf(input.operationId, input.actor, hash);
        if (repeated) return { movement: repeated, replayed: true };
      }
      continue;
    }
    await AssetModel.updateOne({ _id: asset._id, version: { $lt: movement.sequence } }, { $set: { ...plan.after, version: movement.sequence } });
    return { movement, replayed: false };
  }
  throw new HttpError(409, 'This asset is changing right now. Try again', 'STOCK_BUSY');
}

// ---------- Registration ----------

export interface RegisterInput extends ReferenceInput {
  operationId: string;
  productId: string;
  assetTag: string;
  serialNumber?: string | null;
  acquiredAt?: string | null;
  notes?: string | null;
  holderId?: string | null;
  status: 'available' | 'in_use';
  reason?: string | null;
}

/**
 * Registers one unit. The asset document and its first movement are two writes: the
 * registration key is stored on the asset, so repeating the request completes a registration
 * that was interrupted instead of creating a second asset.
 */
export async function registerAsset(input: RegisterInput, actor: PublicUser): Promise<{ movement: StockMovementDocument; replayed: boolean }> {
  const hash = requestHash({ type: 'asset_register', ...input });
  const replay = await replayOf(input.operationId, actor, hash);
  if (replay) return { movement: replay, replayed: true };
  const product = await findProduct(input.productId);
  if (product.tracking !== 'asset') throw new HttpError(400, 'This product is counted by quantity; register a receipt instead', 'TRACKING_MISMATCH');
  if (!product.active) throw new HttpError(409, 'This product is inactive', 'PRODUCT_INACTIVE');
  const refs = await resolveReferences({ ...input, recipientId: input.holderId });
  if (input.status === 'in_use' && !refs.location) throw new HttpError(400, 'An asset in use needs a department or room');
  const state: AssetState = input.status === 'in_use'
    ? { status: 'in_use', location: refs.location, holder: refs.recipient, ticket: null }
    : { status: 'available', location: null, holder: null, ticket: null };

  let asset = await AssetModel.findOne({ registrationOperationId: input.operationId });
  if (!asset) {
    try {
      asset = await AssetModel.create({
        product: product._id, assetTag: input.assetTag, serialNumber: input.serialNumber || null, acquiredAt: input.acquiredAt ? new Date(input.acquiredAt) : null,
        notes: input.notes || null, ...state, version: 0, registrationOperationId: input.operationId, createdBy: actor.id,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const keys = duplicateKeyOf(error);
      if (keys.includes('assetTag')) throw new HttpError(409, 'This asset tag is already in use', 'ASSET_TAG_TAKEN');
      if (keys.includes('serialNumber')) throw new HttpError(409, 'This serial number is already registered for this model', 'SERIAL_TAKEN');
      asset = await AssetModel.findOne({ registrationOperationId: input.operationId });
      if (!asset) throw error;
    }
  }
  try {
    const movement = await StockMovementModel.create({
      kind: 'asset', type: 'asset_register', product: product._id, asset: asset._id, sequence: 1, quantity: 1,
      before: { status: null }, after: { ...state }, ...actorFields(actor), operationId: input.operationId, requestHash: hash,
      reason: input.reason?.trim() || null, ticket: refs.ticket, recipient: refs.recipient, location: refs.location, fromLocation: null,
      condition: null, closes: null, reverses: null,
    });
    await AssetModel.updateOne({ _id: asset._id, version: { $lt: 1 } }, { $set: { version: 1 } });
    return { movement, replayed: false };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const repeated = await replayOf(input.operationId, actor, hash);
    if (repeated) return { movement: repeated, replayed: true };
    throw error;
  }
}

// ---------- Changes ----------

export interface AssetActionInput extends ReferenceInput {
  operationId: string;
  reason?: string | null;
  holderId?: string | null;
}

export function changeAsset(assetId: string, action: AssetAction, input: AssetActionInput, actor: PublicUser) {
  return recordAsset({
    assetId, type: action, operationId: input.operationId, payload: { ...input }, actor,
    plan: async (state) => {
      const rule = TRANSITIONS[action];
      if (!rule.from.includes(state.status)) throw new HttpError(409, `An asset that is ${state.status} cannot do this`, 'INVALID_TRANSITION');
      const refs = await resolveReferences({ ...input, recipientId: input.holderId });
      if (action === 'asset_reserve' && !refs.ticket) throw new HttpError(400, 'A reservation is for a ticket');
      if ((action === 'asset_assign' || action === 'asset_transfer') && !refs.location) throw new HttpError(400, 'Say where the asset goes (department or room)');
      if ((action === 'asset_retire' || action === 'asset_defective' || action === 'asset_maintenance') && !input.reason?.trim()) throw new HttpError(400, 'A reason is required');
      const inUse = rule.to === 'in_use';
      const after: AssetState = {
        status: rule.to,
        location: inUse ? refs.location : null,
        holder: inUse ? refs.recipient : null,
        ticket: rule.to === 'reserved' ? refs.ticket : null,
      };
      return {
        after,
        fields: {
          reason: input.reason?.trim() || null,
          ticket: refs.ticket ?? (action === 'asset_assign' || action === 'asset_reservation_cancel' ? state.ticket : null),
          recipient: refs.recipient, location: refs.location ?? null, fromLocation: state.location,
          condition: action === 'asset_defective' ? 'defective' : null,
        },
      };
    },
  });
}

// ---------- Reading ----------

export interface AssetView {
  id: string;
  assetTag: string;
  serialNumber: string | null;
  product: { id: string; name: string; type: string; brand: string | null; model: string | null } | null;
  status: AssetStatus;
  location: LocationView | null;
  holder: { id: string; name: string } | null;
  ticket: { id: string; title: string } | null;
  acquiredAt: Date | null;
  notes: string | null;
  version: number;
  updatedAt: Date;
}

export async function assetViews(assets: AssetDocument[]): Promise<AssetView[]> {
  const [products, tickets] = await Promise.all([
    ProductModel.find({ _id: { $in: assets.map((a) => a.product) } }).select('name type brand model'),
    TicketModel.find({ _id: { $in: assets.map((a) => a.ticket).filter(Boolean) } }).select('title'),
  ]);
  return assets.map((asset) => {
    const product = products.find((p) => p._id.equals(asset.product));
    const ticket = asset.ticket ? tickets.find((t) => t._id.equals(asset.ticket!)) : null;
    return {
      id: asset.id, assetTag: asset.assetTag, serialNumber: asset.serialNumber ?? null,
      product: product ? { id: product.id, name: product.name, type: product.type, brand: product.brand ?? null, model: product.model ?? null } : null,
      status: asset.status, location: toLocationView(asset.location), holder: asset.holder ? { id: asset.holder.id.toString(), name: asset.holder.name } : null,
      ticket: ticket ? { id: ticket.id, title: ticket.title } : null, acquiredAt: asset.acquiredAt ?? null, notes: asset.notes ?? null,
      version: asset.version, updatedAt: asset.updatedAt,
    };
  });
}

export async function getAsset(id: string): Promise<AssetDocument> {
  const asset = await findAsset(id);
  await currentState(asset);
  return findAsset(id);
}

export interface AssetFilters {
  q?: string;
  status?: AssetStatus;
  productId?: string;
  departmentId?: string;
  holderId?: string;
  page: number;
  limit: number;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listAssets(filters: AssetFilters) {
  const query: Record<string, unknown> = {};
  if (filters.status) query.status = filters.status;
  if (filters.productId) query.product = new Types.ObjectId(filters.productId);
  if (filters.departmentId) query['location.departmentId'] = new Types.ObjectId(filters.departmentId);
  if (filters.holderId) query['holder.id'] = new Types.ObjectId(filters.holderId);
  if (filters.q) {
    const pattern = { $regex: escapeRegex(filters.q.trim()), $options: 'i' };
    query.$or = [{ assetTag: pattern }, { serialNumber: pattern }, { 'holder.name': pattern }];
  }
  const [total, assets] = await Promise.all([
    AssetModel.countDocuments(query),
    AssetModel.find(query).sort({ assetTag: 1 }).skip((filters.page - 1) * filters.limit).limit(filters.limit),
  ]);
  return { assets: await assetViews(assets), pagination: { page: filters.page, limit: filters.limit, total, totalPages: Math.ceil(total / filters.limit) } };
}

/** The authenticated person's own equipment, to say which one has a problem. No other people's assets. */
export async function myAssets(actor: PublicUser): Promise<{ id: string; assetTag: string; name: string; type: string }[]> {
  const assets = await AssetModel.find({ 'holder.id': new Types.ObjectId(actor.id), status: 'in_use' }).sort({ assetTag: 1 });
  return (await assetViews(assets)).map((asset) => ({ id: asset.id, assetTag: asset.assetTag, name: asset.product?.name ?? 'Equipamento', type: asset.product?.type ?? 'outro' }));
}
