import type { PipelineStage } from 'mongoose';
import { AssetModel, ProductModel, StockMovementModel, type AssetStatus } from '../models/inventory.model';
import { productViews } from './catalog.service';
import { resolveOriginFilter, type DataOrigin } from './data-origin';
import { periodRange, type ExplicitRange, type ManagerFilters } from './manager.service';

/**
 * Stock and equipment for management decisions: what to restock, which models break more,
 * which departments consume more and what is out of use. Facts only: consuming more is not
 * called waste, and units are never mixed with the number of product types.
 *
 * The stock on hand is physical (one reality, no origin). Consumption in the period follows the
 * origin chosen on the management view, like every other indicator there.
 */
export interface InventoryInsights {
  range: { start: Date; end: Date };
  origin: DataOrigin;
  stock: {
    activeProducts: number;
    unitsAvailable: number;
    belowMinimum: { id: string; name: string; tracking: string; available: number; minStock: number }[];
  };
  assets: Partial<Record<AssetStatus, number>>;
  period: {
    deliveredUnits: number;
    linkedToTickets: number;
    topProducts: { id: string; name: string; units: number }[];
    byDepartment: { id: string; name: string; units: number }[];
    /** The most delivered products of each department (up to 3 each). */
    departmentProducts: { departmentId: string; department: string; products: { name: string; units: number }[] }[];
    defectsByProduct: { id: string; name: string; units: number }[];
  };
}

const DELIVERIES = ['issue', 'asset_assign'];
const DEFECTS = { $or: [{ type: 'return', condition: 'defective' }, { type: 'asset_defective' }] };

export async function inventoryInsights(filters: { period: ManagerFilters['period']; dataOrigin?: DataOrigin }, now = new Date(), explicit?: ExplicitRange): Promise<InventoryInsights> {
  const range = explicit ?? periodRange(filters.period, now);
  const origin = resolveOriginFilter(filters.dataOrigin ?? 'operational') ?? 'operational';
  // Legacy has no movements: every movement has a proven author.
  const base: Record<string, unknown> = { occurredAt: { $gte: range.start, $lt: range.end }, dataOrigin: origin === 'legacy' ? '__none__' : origin };
  // A reversed movement did not really happen; its reversal is not consumption either.
  const notReversed: PipelineStage[] = [
    { $lookup: { from: 'stockmovements', localField: '_id', foreignField: 'reverses', as: 'reversal' } },
    { $match: { reversal: { $size: 0 } } },
  ];
  const sumBy = (key: string, extra: Record<string, unknown> = {}): PipelineStage[] => [
    { $match: { ...base, ...extra } }, ...notReversed,
    { $group: { _id: key, name: { $first: key === '$location.departmentId' ? '$location.departmentName' : null }, units: { $sum: '$quantity' } } },
    { $match: { _id: { $ne: null } } }, { $sort: { units: -1, _id: 1 } }, { $limit: 8 },
  ];

  const [products, assetRows, delivered, linked, top, departments, defects, departmentProducts] = await Promise.all([
    ProductModel.find({ active: true }),
    AssetModel.aggregate<{ _id: AssetStatus; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    StockMovementModel.aggregate<{ units: number }>([{ $match: { ...base, type: { $in: DELIVERIES } } }, ...notReversed, { $group: { _id: null, units: { $sum: '$quantity' } } }]),
    StockMovementModel.countDocuments({ ...base, ticket: { $type: 'objectId' } }),
    StockMovementModel.aggregate<{ _id: unknown; units: number }>(sumBy('$product', { type: { $in: DELIVERIES } })),
    StockMovementModel.aggregate<{ _id: unknown; name: string; units: number }>(sumBy('$location.departmentId', { type: { $in: DELIVERIES } })),
    StockMovementModel.aggregate<{ _id: unknown; units: number }>(sumBy('$product', DEFECTS)),
    StockMovementModel.aggregate<{ _id: { department: unknown; product: unknown }; department: string; units: number }>([
      { $match: { ...base, type: { $in: DELIVERIES }, 'location.departmentId': { $ne: null } } }, ...notReversed,
      { $group: { _id: { department: '$location.departmentId', product: '$product' }, department: { $first: '$location.departmentName' }, units: { $sum: '$quantity' } } },
      { $sort: { units: -1, '_id.product': 1 } },
    ]),
  ]);
  const views = await productViews(products);
  const names = new Map((await ProductModel.find({ _id: { $in: [...top, ...defects, ...departmentProducts.map((row) => ({ _id: row._id.product }))].map((row) => row._id) } }).select('name')).map((p) => [p.id, p.name]));
  const perDepartment = new Map<string, InventoryInsights['period']['departmentProducts'][number]>();
  for (const row of departmentProducts) {
    const key = String(row._id.department);
    const entry = perDepartment.get(key) ?? { departmentId: key, department: row.department, products: [] };
    if (entry.products.length < 3) entry.products.push({ name: names.get(String(row._id.product)) ?? 'Produto removido', units: row.units });
    perDepartment.set(key, entry);
  }
  const named = (rows: { _id: unknown; units: number }[]) => rows.map((row) => ({ id: String(row._id), name: names.get(String(row._id)) ?? 'Produto removido', units: row.units }));

  return {
    range: { start: range.start, end: range.end },
    origin,
    stock: {
      activeProducts: views.length,
      unitsAvailable: views.reduce((sum, view) => sum + (view.stock?.available ?? 0), 0),
      belowMinimum: views.filter((view) => view.belowMinimum).map((view) => ({
        id: view.id, name: view.name, tracking: view.tracking, available: view.stock?.available ?? view.assets?.available ?? 0, minStock: view.minStock,
      })),
    },
    assets: Object.fromEntries(assetRows.map((row) => [row._id, row.count])),
    period: {
      deliveredUnits: delivered[0]?.units ?? 0,
      linkedToTickets: linked,
      topProducts: named(top),
      byDepartment: departments.map((row) => ({ id: String(row._id), name: row.name, units: row.units })),
      departmentProducts: [...perDepartment.values()],
      defectsByProduct: named(defects),
    },
  };
}
