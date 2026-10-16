import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * Stock and assets of the IT team.
 *
 * - A product is a catalog entry (brand, model, characteristics). Its tracking mode never changes:
 *   "quantity" counts interchangeable units (keyboards, cables); "asset" tracks each unit by its
 *   asset tag (notebooks, monitors).
 * - Every change is a movement in an append-only ledger. A movement is the source of truth: it
 *   carries the state before and after, the author, the server time and an idempotency key.
 * - Product.stock and the asset's current fields are projections of the last movement, kept for
 *   fast reads and repaired from the ledger if a write is interrupted.
 */

export const PRODUCT_TYPES = ['teclado', 'mouse', 'monitor', 'notebook', 'computador', 'memoria', 'ssd', 'cabo', 'adaptador', 'headset', 'fonte', 'impressora', 'rede', 'outro'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const TRACKING_MODES = ['quantity', 'asset'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];
export const PRODUCT_UNITS = ['unidade', 'metro', 'caixa', 'pacote'] as const;

export const ASSET_STATUSES = ['available', 'reserved', 'in_use', 'in_maintenance', 'defective', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const QUANTITY_MOVEMENTS = ['receipt', 'reserve', 'reservation_cancel', 'issue', 'return', 'adjustment', 'discard', 'reversal'] as const;
export const ASSET_MOVEMENTS = ['asset_register', 'asset_reserve', 'asset_reservation_cancel', 'asset_assign', 'asset_transfer', 'asset_return', 'asset_maintenance', 'asset_defective', 'asset_retire'] as const;
export const MOVEMENT_TYPES = [...QUANTITY_MOVEMENTS, ...ASSET_MOVEMENTS] as const;
export type QuantityMovementType = (typeof QUANTITY_MOVEMENTS)[number];
export type AssetMovementType = (typeof ASSET_MOVEMENTS)[number];
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const INVENTORY_LIMITS = { skuMax: 40, nameMax: 120, brandMax: 60, modelMax: 60, descriptionMax: 1000, reasonMin: 5, reasonMax: 500, tagMax: 40, serialMax: 80, notesMax: 500, quantityMax: 100000 } as const;

/** Units in the store room. available = onHand − reserved; defective units are kept apart. */
export interface StockLevels {
  onHand: number;
  reserved: number;
  defective: number;
}

export interface Product {
  sku: string | null;
  name: string;
  type: ProductType;
  brand: string | null;
  model: string | null;
  description: string | null;
  attributes: Record<string, string | number | boolean>;
  unit: (typeof PRODUCT_UNITS)[number];
  minStock: number;
  tracking: TrackingMode;
  active: boolean;
  /** Normalized name, brand, model and SKU, for searching. */
  searchText: string;
  stock: StockLevels & { version: number };
  revision: number;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocationRef {
  departmentId: Types.ObjectId;
  departmentName: string;
  roomId: Types.ObjectId | null;
  roomName: string | null;
}

export interface PersonRef {
  id: Types.ObjectId;
  name: string;
}

export interface AssetState {
  status: AssetStatus;
  location: LocationRef | null;
  holder: PersonRef | null;
  /** Ticket the asset is reserved for. */
  ticket: Types.ObjectId | null;
}

export interface Asset extends AssetState {
  product: Types.ObjectId;
  assetTag: string;
  serialNumber: string | null;
  acquiredAt: Date | null;
  notes: string | null;
  version: number;
  /** Idempotency key of the registration, so a repeated request completes it instead of duplicating. */
  registrationOperationId: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockMovement {
  kind: TrackingMode;
  type: MovementType;
  product: Types.ObjectId;
  asset: Types.ObjectId | null;
  /** Position in the ledger of this product (quantity) or asset; unique, so writes are serialized. */
  sequence: number;
  quantity: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  actor: Types.ObjectId;
  actorSnapshot: { name: string; role: string };
  occurredAt: Date;
  reason: string | null;
  ticket: Types.ObjectId | null;
  recipient: PersonRef | null;
  /** Destination (or where it happened). For asset moves, fromLocation is where it was. */
  location: LocationRef | null;
  fromLocation: LocationRef | null;
  condition: 'good' | 'defective' | null;
  /** The reservation this movement closes (cancel or delivery); a reservation closes once. */
  closes: Types.ObjectId | null;
  /** The movement this one compensates; a movement is reversed at most once. */
  reverses: Types.ObjectId | null;
  operationId: string;
  requestHash: string;
  dataOrigin: 'operational' | 'demo';
}

export type ProductDocument = HydratedDocument<Product>;
export type AssetDocument = HydratedDocument<Asset>;
export type StockMovementDocument = HydratedDocument<StockMovement>;

const locationSchema = new Schema<LocationRef>({
  departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
  departmentName: { type: String, required: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', default: null },
  roomName: { type: String, default: null },
}, { _id: false });

const personSchema = new Schema<PersonRef>({
  id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
}, { _id: false });

const productSchema = new Schema<Product>(
  {
    sku: { type: String, trim: true, uppercase: true, maxlength: INVENTORY_LIMITS.skuMax, default: null },
    name: { type: String, required: true, trim: true, maxlength: INVENTORY_LIMITS.nameMax },
    type: { type: String, enum: PRODUCT_TYPES, required: true },
    brand: { type: String, trim: true, maxlength: INVENTORY_LIMITS.brandMax, default: null },
    model: { type: String, trim: true, maxlength: INVENTORY_LIMITS.modelMax, default: null },
    description: { type: String, trim: true, maxlength: INVENTORY_LIMITS.descriptionMax, default: null },
    attributes: { type: Schema.Types.Mixed, default: {} },
    unit: { type: String, enum: PRODUCT_UNITS, default: 'unidade' },
    minStock: { type: Number, min: 0, default: 0, validate: Number.isInteger },
    tracking: { type: String, enum: TRACKING_MODES, required: true, immutable: true },
    active: { type: Boolean, default: true },
    searchText: { type: String, required: true },
    stock: {
      onHand: { type: Number, min: 0, default: 0 },
      reserved: { type: Number, min: 0, default: 0 },
      defective: { type: Number, min: 0, default: 0 },
      version: { type: Number, min: 0, default: 0 },
    },
    revision: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, minimize: false },
);
productSchema.index({ sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: 'string' } } });
productSchema.index({ type: 1, active: 1 });

const assetSchema = new Schema<Asset>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    assetTag: { type: String, required: true, trim: true, uppercase: true, maxlength: INVENTORY_LIMITS.tagMax },
    serialNumber: { type: String, trim: true, maxlength: INVENTORY_LIMITS.serialMax, default: null },
    status: { type: String, enum: ASSET_STATUSES, required: true },
    location: { type: locationSchema, default: null },
    holder: { type: personSchema, default: null },
    ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    acquiredAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: INVENTORY_LIMITS.notesMax, default: null },
    version: { type: Number, min: 0, default: 0 },
    registrationOperationId: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
assetSchema.index({ assetTag: 1 }, { unique: true });
// A serial number, when known, identifies one unit of a model.
assetSchema.index({ product: 1, serialNumber: 1 }, { unique: true, partialFilterExpression: { serialNumber: { $type: 'string' } } });
assetSchema.index({ registrationOperationId: 1 }, { unique: true });
assetSchema.index({ status: 1, 'location.departmentId': 1 });
assetSchema.index({ 'holder.id': 1 });

const movementSchema = new Schema<StockMovement>(
  {
    kind: { type: String, enum: TRACKING_MODES, required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    asset: { type: Schema.Types.ObjectId, ref: 'Asset', default: null },
    sequence: { type: Number, required: true, min: 1 },
    quantity: { type: Number, required: true, min: 1 },
    before: { type: Schema.Types.Mixed, required: true },
    after: { type: Schema.Types.Mixed, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorSnapshot: { name: { type: String, required: true }, role: { type: String, required: true } },
    occurredAt: { type: Date, required: true },
    reason: { type: String, default: null },
    ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    recipient: { type: personSchema, default: null },
    location: { type: locationSchema, default: null },
    fromLocation: { type: locationSchema, default: null },
    condition: { type: String, enum: ['good', 'defective', null], default: null },
    closes: { type: Schema.Types.ObjectId, ref: 'StockMovement', default: null },
    reverses: { type: Schema.Types.ObjectId, ref: 'StockMovement', default: null },
    operationId: { type: String, required: true },
    requestHash: { type: String, required: true },
    dataOrigin: { type: String, enum: ['operational', 'demo'], required: true },
  },
  { minimize: false },
);
movementSchema.index({ operationId: 1 }, { unique: true });
movementSchema.index({ product: 1, sequence: 1 }, { unique: true, partialFilterExpression: { kind: 'quantity' } });
movementSchema.index({ asset: 1, sequence: 1 }, { unique: true, partialFilterExpression: { kind: 'asset' } });
movementSchema.index({ closes: 1 }, { unique: true, partialFilterExpression: { closes: { $type: 'objectId' } } });
movementSchema.index({ reverses: 1 }, { unique: true, partialFilterExpression: { reverses: { $type: 'objectId' } } });
movementSchema.index({ ticket: 1, occurredAt: -1 });
movementSchema.index({ occurredAt: -1 });
movementSchema.index({ product: 1, occurredAt: -1 });

// The ledger is append-only: the application never updates or deletes a movement.
for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  movementSchema.pre(hook, function refuseChange() {
    throw new Error('Stock movements are append-only; record a compensating movement instead');
  });
}

export const ProductModel = model<Product>('Product', productSchema);
export const AssetModel = model<Asset>('Asset', assetSchema);
export const StockMovementModel = model<StockMovement>('StockMovement', movementSchema);
