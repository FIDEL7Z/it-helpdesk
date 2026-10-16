import { Types } from 'mongoose';
import { HttpError } from '../errors/http-error';
import {
  AssetModel,
  INVENTORY_LIMITS,
  ProductModel,
  type AssetStatus,
  type ProductDocument,
  type ProductType,
  type TrackingMode,
} from '../models/inventory.model';
import type { PublicUser } from '../models/user.model';
import { normalizeForSearch } from './article.service';

/**
 * Optional characteristics per product type. Small on purpose: what a technician checks before
 * swapping a part, not a full hardware specification.
 */
export type AttributeSpec =
  | { key: string; label: string; kind: 'enum'; options: string[] }
  | { key: string; label: string; kind: 'int' | 'number'; min: number; max: number; unit?: string }
  | { key: string; label: string; kind: 'text'; maxLength: number }
  | { key: string; label: string; kind: 'bool' };

const connection = { key: 'connection', label: 'Conexão', kind: 'enum', options: ['USB', 'USB-C', 'Bluetooth', 'Receptor USB', 'PS/2'] } as const;
const wireless = { key: 'wireless', label: 'Sem fio', kind: 'bool' } as const;

export const PRODUCT_TYPE_CATALOG: Record<ProductType, { label: string; attributes: AttributeSpec[] }> = {
  teclado: { label: 'Teclado', attributes: [{ key: 'layout', label: 'Layout', kind: 'enum', options: ['ABNT2', 'US', 'Outro'] }, { ...connection, options: [...connection.options] }, wireless, { key: 'switchType', label: 'Tipo', kind: 'enum', options: ['Membrana', 'Mecânico'] }] },
  mouse: { label: 'Mouse', attributes: [{ ...connection, options: [...connection.options] }, wireless, { key: 'dpi', label: 'DPI', kind: 'int', min: 100, max: 30000 }] },
  monitor: { label: 'Monitor', attributes: [{ key: 'sizeInches', label: 'Tamanho', kind: 'number', min: 10, max: 100, unit: 'polegadas' }, { key: 'resolution', label: 'Resolução', kind: 'text', maxLength: 20 }, { key: 'videoInputs', label: 'Entradas de vídeo', kind: 'text', maxLength: 60 }] },
  notebook: { label: 'Notebook', attributes: [{ key: 'processor', label: 'Processador', kind: 'text', maxLength: 80 }, { key: 'ramGb', label: 'Memória RAM', kind: 'int', min: 1, max: 1024, unit: 'GB' }, { key: 'storageGb', label: 'Armazenamento', kind: 'int', min: 1, max: 100000, unit: 'GB' }] },
  computador: { label: 'Computador', attributes: [{ key: 'processor', label: 'Processador', kind: 'text', maxLength: 80 }, { key: 'ramGb', label: 'Memória RAM', kind: 'int', min: 1, max: 1024, unit: 'GB' }, { key: 'storageGb', label: 'Armazenamento', kind: 'int', min: 1, max: 100000, unit: 'GB' }] },
  memoria: { label: 'Memória RAM', attributes: [{ key: 'capacityGb', label: 'Capacidade', kind: 'int', min: 1, max: 512, unit: 'GB' }, { key: 'generation', label: 'Tipo', kind: 'enum', options: ['DDR3', 'DDR4', 'DDR5'] }, { key: 'formFactor', label: 'Formato', kind: 'enum', options: ['DIMM', 'SODIMM'] }] },
  ssd: { label: 'SSD', attributes: [{ key: 'capacityGb', label: 'Capacidade', kind: 'int', min: 1, max: 100000, unit: 'GB' }, { key: 'interface', label: 'Interface', kind: 'enum', options: ['SATA', 'NVMe'] }, { key: 'formFactor', label: 'Formato', kind: 'enum', options: ['2,5"', 'M.2'] }] },
  cabo: { label: 'Cabo', attributes: [{ key: 'connector', label: 'Conector', kind: 'text', maxLength: 40 }, { key: 'lengthM', label: 'Comprimento', kind: 'number', min: 0.1, max: 100, unit: 'm' }] },
  adaptador: { label: 'Adaptador', attributes: [{ key: 'from', label: 'De', kind: 'text', maxLength: 40 }, { key: 'to', label: 'Para', kind: 'text', maxLength: 40 }] },
  headset: { label: 'Headset', attributes: [{ ...connection, options: [...connection.options] }, wireless] },
  fonte: { label: 'Fonte de alimentação', attributes: [{ key: 'watts', label: 'Potência', kind: 'int', min: 10, max: 2000, unit: 'W' }] },
  impressora: { label: 'Impressora', attributes: [{ key: 'technology', label: 'Tecnologia', kind: 'enum', options: ['Laser', 'Jato de tinta', 'Térmica'] }, { key: 'network', label: 'Em rede', kind: 'bool' }] },
  rede: { label: 'Equipamento de rede', attributes: [{ key: 'kind', label: 'Equipamento', kind: 'enum', options: ['Switch', 'Roteador', 'Access point', 'Outro'] }, { key: 'ports', label: 'Portas', kind: 'int', min: 1, max: 128 }] },
  outro: { label: 'Outro', attributes: [] },
};

/** Keeps only known characteristics of the type, with valid values; unknown keys or values are 400. */
export function validateAttributes(type: ProductType, input: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const specs = PRODUCT_TYPE_CATALOG[type].attributes;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === null || value === '') continue;
    const spec = specs.find((item) => item.key === key);
    if (!spec) throw new HttpError(400, `Unknown characteristic "${key}" for this type`);
    const fail = () => { throw new HttpError(400, `Invalid value for "${spec.label}"`); };
    if (spec.kind === 'enum') { if (typeof value !== 'string' || !spec.options.includes(value)) fail(); result[key] = value as string; }
    if (spec.kind === 'bool') { if (typeof value !== 'boolean') fail(); result[key] = value as boolean; }
    if (spec.kind === 'text') { if (typeof value !== 'string' || !value.trim() || value.trim().length > spec.maxLength) fail(); result[key] = (value as string).trim(); }
    if (spec.kind === 'int' || spec.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.kind === 'int' && !Number.isInteger(value))) fail();
      result[key] = value as number;
    }
  }
  return result;
}

export interface ProductView {
  id: string;
  sku: string | null;
  name: string;
  type: ProductType;
  brand: string | null;
  model: string | null;
  description: string | null;
  attributes: Record<string, string | number | boolean>;
  unit: string;
  minStock: number;
  tracking: TrackingMode;
  active: boolean;
  revision: number;
  /** Quantity products: units in the store room. Asset products: assets by status. */
  stock: { onHand: number; reserved: number; available: number; defective: number } | null;
  assets: Partial<Record<AssetStatus, number>> | null;
  /** Available below the minimum (only when a minimum is set). */
  belowMinimum: boolean;
  updatedAt: Date;
}

const available = (product: ProductDocument) => product.stock.onHand - product.stock.reserved;

export function toProductView(product: ProductDocument, assetCounts?: Partial<Record<AssetStatus, number>>): ProductView {
  const quantity = product.tracking === 'quantity';
  const free = quantity ? available(product) : assetCounts?.available ?? 0;
  return {
    id: product.id, sku: product.sku ?? null, name: product.name, type: product.type, brand: product.brand ?? null,
    model: product.model ?? null, description: product.description ?? null, attributes: product.attributes ?? {},
    unit: product.unit, minStock: product.minStock, tracking: product.tracking, active: product.active, revision: product.revision,
    stock: quantity ? { onHand: product.stock.onHand, reserved: product.stock.reserved, available: free, defective: product.stock.defective } : null,
    assets: quantity ? null : assetCounts ?? {},
    belowMinimum: product.minStock > 0 && free < product.minStock,
    updatedAt: product.updatedAt,
  };
}

async function assetCountsFor(ids: Types.ObjectId[]): Promise<Map<string, Partial<Record<AssetStatus, number>>>> {
  const rows = await AssetModel.aggregate<{ _id: { product: Types.ObjectId; status: AssetStatus }; count: number }>([
    { $match: { product: { $in: ids } } },
    { $group: { _id: { product: '$product', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const map = new Map<string, Partial<Record<AssetStatus, number>>>();
  for (const row of rows) {
    const key = row._id.product.toString();
    map.set(key, { ...map.get(key), [row._id.status]: row.count });
  }
  return map;
}

export async function productViews(products: ProductDocument[]): Promise<ProductView[]> {
  const counts = await assetCountsFor(products.filter((p) => p.tracking === 'asset').map((p) => p._id));
  return products.map((product) => toProductView(product, counts.get(product.id)));
}

const searchTextOf = (fields: { name: string; brand?: string | null; model?: string | null; sku?: string | null }) =>
  normalizeForSearch([fields.name, fields.brand, fields.model, fields.sku].filter(Boolean).join(' '));

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDuplicate = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

export interface ProductInput {
  sku?: string | null;
  name: string;
  type: ProductType;
  brand?: string | null;
  model?: string | null;
  description?: string | null;
  attributes?: Record<string, unknown>;
  unit?: 'unidade' | 'metro' | 'caixa' | 'pacote';
  minStock?: number;
  tracking: TrackingMode;
}

export async function createProduct(input: ProductInput, actor: PublicUser): Promise<ProductView> {
  if (input.tracking === 'asset' && input.unit && input.unit !== 'unidade') throw new HttpError(400, 'Assets are counted in units');
  try {
    const product = await ProductModel.create({
      ...input,
      attributes: validateAttributes(input.type, input.attributes),
      searchText: searchTextOf(input),
      stock: { onHand: 0, reserved: 0, defective: 0, version: 0 },
      createdBy: actor.id,
      updatedBy: actor.id,
    });
    return (await productViews([product]))[0];
  } catch (error) {
    if (isDuplicate(error)) throw new HttpError(409, 'A product with this SKU already exists');
    throw error;
  }
}

/** Catalog fields only. Stock never changes here, and the type and tracking mode are fixed. */
export async function updateProduct(id: string, input: Partial<Omit<ProductInput, 'type' | 'tracking'>> & { active?: boolean; expectedRevision: number }, actor: PublicUser): Promise<ProductView> {
  const product = await findProduct(id);
  if (product.revision !== input.expectedRevision) throw new HttpError(409, 'This product was changed by someone else. Reload and try again');
  const { expectedRevision: _revision, ...fields } = input;
  const next = { ...fields, ...(fields.attributes !== undefined && { attributes: validateAttributes(product.type, fields.attributes) }) };
  const merged = { name: next.name ?? product.name, brand: next.brand !== undefined ? next.brand : product.brand, model: next.model !== undefined ? next.model : product.model, sku: next.sku !== undefined ? next.sku : product.sku };
  try {
    const updated = await ProductModel.findOneAndUpdate(
      { _id: product._id, revision: product.revision },
      { $set: { ...next, searchText: searchTextOf(merged), updatedBy: new Types.ObjectId(actor.id) }, $inc: { revision: 1 } },
      { new: true, runValidators: true },
    );
    if (!updated) throw new HttpError(409, 'This product was changed by someone else. Reload and try again');
    return (await productViews([updated]))[0];
  } catch (error) {
    if (isDuplicate(error)) throw new HttpError(409, 'A product with this SKU already exists');
    throw error;
  }
}

export async function findProduct(id: string): Promise<ProductDocument> {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(400, 'Invalid product id');
  const product = await ProductModel.findById(id);
  if (!product) throw new HttpError(404, 'Product not found');
  return product;
}

export interface ProductFilters {
  q?: string;
  type?: ProductType;
  tracking?: TrackingMode;
  status?: 'active' | 'inactive' | 'all';
  belowMinimum?: boolean;
  page: number;
  limit: number;
}

export async function listProducts(filters: ProductFilters): Promise<{ products: ProductView[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const query: Record<string, unknown> = {};
  if (filters.type) query.type = filters.type;
  if (filters.tracking) query.tracking = filters.tracking;
  if ((filters.status ?? 'active') !== 'all') query.active = (filters.status ?? 'active') === 'active';
  const words = normalizeForSearch(filters.q ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length) query.$and = words.map((word) => ({ searchText: { $regex: escapeRegex(word) } }));
  // The minimum depends on asset counts for asset products, so this filter is applied after reading.
  const all = await productViews(await ProductModel.find(query).sort({ type: 1, name: 1, _id: 1 }));
  const rows = filters.belowMinimum ? all.filter((product) => product.belowMinimum) : all;
  const start = (filters.page - 1) * filters.limit;
  return {
    products: rows.slice(start, start + filters.limit),
    pagination: { page: filters.page, limit: filters.limit, total: rows.length, totalPages: Math.ceil(rows.length / filters.limit) },
  };
}

export { INVENTORY_LIMITS };
