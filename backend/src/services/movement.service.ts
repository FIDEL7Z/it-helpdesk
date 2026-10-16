import { Types } from 'mongoose';
import { HttpError } from '../errors/http-error';
import { AssetModel, MOVEMENT_TYPES, ProductModel, StockMovementModel, type MovementType, type StockMovementDocument } from '../models/inventory.model';
import { TicketModel } from '../models/ticket.model';
import { toLocationView, type LocationView } from './organization.service';

export interface MovementView {
  id: string;
  kind: 'quantity' | 'asset';
  type: MovementType;
  sequence: number;
  product: { id: string; name: string; sku: string | null; type: string } | null;
  asset: { id: string; assetTag: string } | null;
  quantity: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  actor: { id: string; name: string; role: string };
  occurredAt: Date;
  reason: string | null;
  ticket: { id: string; title: string } | null;
  recipient: { id: string; name: string } | null;
  location: LocationView | null;
  fromLocation: LocationView | null;
  condition: 'good' | 'defective' | null;
  closes: string | null;
  reverses: string | null;
  /** The movement that compensated this one, if any. */
  reversedBy: string | null;
  dataOrigin: 'operational' | 'demo';
}

/** Readable views of ledger entries, with product, asset and ticket names in one batch. */
export async function movementViews(movements: StockMovementDocument[]): Promise<MovementView[]> {
  const ids = (pick: (m: StockMovementDocument) => Types.ObjectId | null) => [...new Set(movements.map(pick).filter(Boolean).map(String))];
  const [products, assets, tickets, reversals] = await Promise.all([
    ProductModel.find({ _id: { $in: ids((m) => m.product) } }).select('name sku type'),
    AssetModel.find({ _id: { $in: ids((m) => m.asset) } }).select('assetTag'),
    TicketModel.find({ _id: { $in: ids((m) => m.ticket) } }).select('title'),
    StockMovementModel.find({ reverses: { $in: movements.map((m) => m._id) } }).select('reverses'),
  ]);
  const byId = <T extends { id: string }>(list: T[], id: Types.ObjectId | null) => (id ? list.find((item) => item.id === id.toString()) : undefined);
  return movements.map((m) => {
    const product = byId(products, m.product);
    const asset = byId(assets, m.asset);
    const ticket = byId(tickets, m.ticket);
    return {
      id: m.id, kind: m.kind, type: m.type, sequence: m.sequence,
      product: product ? { id: product.id, name: product.name, sku: product.sku ?? null, type: product.type } : null,
      asset: asset ? { id: asset.id, assetTag: asset.assetTag } : null,
      quantity: m.quantity, before: m.before, after: m.after,
      actor: { id: m.actor.toString(), name: m.actorSnapshot.name, role: m.actorSnapshot.role },
      occurredAt: m.occurredAt, reason: m.reason ?? null,
      ticket: ticket ? { id: ticket.id, title: ticket.title } : m.ticket ? { id: m.ticket.toString(), title: 'Chamado indisponível' } : null,
      recipient: m.recipient ? { id: m.recipient.id.toString(), name: m.recipient.name } : null,
      location: toLocationView(m.location), fromLocation: toLocationView(m.fromLocation),
      condition: m.condition ?? null, closes: m.closes?.toString() ?? null, reverses: m.reverses?.toString() ?? null,
      reversedBy: reversals.find((r) => r.reverses?.equals(m._id))?.id ?? null,
      dataOrigin: m.dataOrigin,
    };
  });
}

export interface MovementFilters {
  type?: MovementType;
  productId?: string;
  assetId?: string;
  ticketId?: string;
  departmentId?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

const oid = (value: string, what: string) => {
  if (!Types.ObjectId.isValid(value)) throw new HttpError(400, `Invalid ${what} id`);
  return new Types.ObjectId(value);
};

export async function listMovements(filters: MovementFilters) {
  const query: Record<string, unknown> = {};
  if (filters.type) query.type = filters.type;
  if (filters.productId) query.product = oid(filters.productId, 'product');
  if (filters.assetId) query.asset = oid(filters.assetId, 'asset');
  if (filters.ticketId) query.ticket = oid(filters.ticketId, 'ticket');
  if (filters.departmentId) query['location.departmentId'] = oid(filters.departmentId, 'department');
  if (filters.from || filters.to) query.occurredAt = { ...(filters.from && { $gte: new Date(filters.from) }), ...(filters.to && { $lt: new Date(filters.to) }) };
  // Physical stock is one reality: every movement is listed, so balances can always be explained.
  // Movements by the reserved fictitious accounts carry dataOrigin 'demo' and are labelled.
  const [total, movements] = await Promise.all([
    StockMovementModel.countDocuments(query),
    StockMovementModel.find(query).sort({ occurredAt: -1, _id: -1 }).skip((filters.page - 1) * filters.limit).limit(filters.limit),
  ]);
  return { movements: await movementViews(movements), pagination: { page: filters.page, limit: filters.limit, total, totalPages: Math.ceil(total / filters.limit) } };
}

export { MOVEMENT_TYPES };
