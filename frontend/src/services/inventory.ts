import { apiRequest } from './api'
import type { Location } from './organization'
import type { Pagination } from './tickets'

export type ProductType = 'teclado' | 'mouse' | 'monitor' | 'notebook' | 'computador' | 'memoria' | 'ssd' | 'cabo' | 'adaptador' | 'headset' | 'fonte' | 'impressora' | 'rede' | 'outro'
export type Tracking = 'quantity' | 'asset'
export type AssetStatus = 'available' | 'reserved' | 'in_use' | 'in_maintenance' | 'defective' | 'retired'
export type MovementType =
  | 'receipt' | 'reserve' | 'reservation_cancel' | 'issue' | 'return' | 'adjustment' | 'discard' | 'reversal'
  | 'asset_register' | 'asset_reserve' | 'asset_reservation_cancel' | 'asset_assign' | 'asset_transfer' | 'asset_return' | 'asset_maintenance' | 'asset_defective' | 'asset_retire'

export type AttributeSpec =
  | { key: string; label: string; kind: 'enum'; options: string[] }
  | { key: string; label: string; kind: 'int' | 'number'; min: number; max: number; unit?: string }
  | { key: string; label: string; kind: 'text'; maxLength: number }
  | { key: string; label: string; kind: 'bool' }
export type TypeCatalog = Record<ProductType, { label: string; attributes: AttributeSpec[] }>

export type Product = {
  id: string
  sku: string | null
  name: string
  type: ProductType
  brand: string | null
  model: string | null
  description: string | null
  attributes: Record<string, string | number | boolean>
  unit: string
  minStock: number
  tracking: Tracking
  active: boolean
  revision: number
  stock: { onHand: number; reserved: number; available: number; defective: number } | null
  assets: Partial<Record<AssetStatus, number>> | null
  belowMinimum: boolean
  updatedAt: string
}

export type Movement = {
  id: string
  kind: Tracking
  type: MovementType
  sequence: number
  product: { id: string; name: string; sku: string | null; type: ProductType } | null
  asset: { id: string; assetTag: string } | null
  quantity: number
  before: Record<string, unknown>
  after: Record<string, unknown>
  actor: { id: string; name: string; role: string }
  occurredAt: string
  reason: string | null
  ticket: { id: string; title: string } | null
  recipient: { id: string; name: string } | null
  location: Location | null
  fromLocation: Location | null
  condition: 'good' | 'defective' | null
  closes: string | null
  reverses: string | null
  reversedBy: string | null
  dataOrigin: 'operational' | 'demo'
}

export type Asset = {
  id: string
  assetTag: string
  serialNumber: string | null
  product: { id: string; name: string; type: ProductType; brand: string | null; model: string | null } | null
  status: AssetStatus
  location: Location | null
  holder: { id: string; name: string } | null
  ticket: { id: string; title: string } | null
  acquiredAt: string | null
  notes: string | null
  version: number
  updatedAt: string
}

export type Insights = {
  origin: 'operational' | 'demo' | 'legacy'
  stock: { activeProducts: number; unitsAvailable: number; belowMinimum: { id: string; name: string; tracking: Tracking; available: number; minStock: number }[] }
  assets: Partial<Record<AssetStatus, number>>
  period: {
    deliveredUnits: number
    linkedToTickets: number
    topProducts: { id: string; name: string; units: number }[]
    byDepartment: { id: string; name: string; units: number }[]
    defectsByProduct: { id: string; name: string; units: number }[]
  }
}

export type TicketMaterials =
  | { view: 'team'; movements: Movement[]; openReservations: Movement[]; reservedAssets: Asset[] }
  | { view: 'requester'; deliveries: { id: string; product: { name: string; type: ProductType }; quantity: number; deliveredAt: string; deliveredBy: { name: string }; receivedByYou: boolean; assetTag: string | null; location: Location | null }[] }

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  available: 'Disponível',
  reserved: 'Reservado',
  in_use: 'Em uso',
  in_maintenance: 'Em manutenção',
  defective: 'Defeituoso',
  retired: 'Baixado',
}

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  receipt: 'Entrada',
  reserve: 'Reserva',
  reservation_cancel: 'Reserva cancelada',
  issue: 'Entrega',
  return: 'Devolução',
  adjustment: 'Ajuste de inventário',
  discard: 'Descarte',
  reversal: 'Estorno',
  asset_register: 'Cadastro do equipamento',
  asset_reserve: 'Reserva do equipamento',
  asset_reservation_cancel: 'Reserva cancelada',
  asset_assign: 'Entrega do equipamento',
  asset_transfer: 'Transferência',
  asset_return: 'Volta ao estoque',
  asset_maintenance: 'Envio para manutenção',
  asset_defective: 'Registrado como defeituoso',
  asset_retire: 'Baixa de patrimônio',
}

export const TRACKING_LABELS: Record<Tracking, string> = { quantity: 'Por quantidade', asset: 'Por patrimônio' }

/** Idempotency key for a change: the same key is sent again if the request is retried. */
export const newOperationId = () => crypto.randomUUID()

type Query = Record<string, string | number | boolean | undefined | null>
const qs = (query: Query) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const getProductTypes = (signal?: AbortSignal): Promise<{ types: TypeCatalog }> => apiRequest('/inventory/product-types', { signal })
export const listProducts = (query: Query, signal?: AbortSignal): Promise<{ products: Product[]; pagination: Pagination }> => apiRequest(`/inventory/products${qs(query)}`, { signal })
export const getProduct = (id: string, signal?: AbortSignal): Promise<{ product: Product; openReservations: Movement[] }> => apiRequest(`/inventory/products/${encodeURIComponent(id)}`, { signal })
export const createProduct = (body: Record<string, unknown>): Promise<{ product: Product }> => apiRequest('/inventory/products', { method: 'POST', body })
export const updateProduct = (id: string, body: Record<string, unknown>): Promise<{ product: Product }> => apiRequest(`/inventory/products/${encodeURIComponent(id)}`, { method: 'PATCH', body })

export type StockAction = 'receipts' | 'reservations' | 'issues' | 'returns' | 'adjustments' | 'discards' | 'reversals'
export const stockAction = (productId: string, action: StockAction, body: Record<string, unknown>): Promise<{ movement: Movement; product: Product; replayed: boolean }> =>
  apiRequest(`/inventory/products/${encodeURIComponent(productId)}/${action}`, { method: 'POST', body })
export const cancelReservation = (productId: string, reservationId: string, body: Record<string, unknown>): Promise<{ movement: Movement; product: Product }> =>
  apiRequest(`/inventory/products/${encodeURIComponent(productId)}/reservations/${encodeURIComponent(reservationId)}/cancel`, { method: 'POST', body })

export const listAssets = (query: Query, signal?: AbortSignal): Promise<{ assets: Asset[]; pagination: Pagination }> => apiRequest(`/inventory/assets${qs(query)}`, { signal })
export const getAsset = (id: string, signal?: AbortSignal): Promise<{ asset: Asset; history: Movement[] }> => apiRequest(`/inventory/assets/${encodeURIComponent(id)}`, { signal })
export const registerAsset = (body: Record<string, unknown>): Promise<{ asset: Asset; movement: Movement }> => apiRequest('/inventory/assets', { method: 'POST', body })
export type AssetActionName = 'reserve' | 'cancel-reservation' | 'assign' | 'transfer' | 'return' | 'maintenance' | 'defective' | 'retire'
export const assetAction = (id: string, action: AssetActionName, body: Record<string, unknown>): Promise<{ asset: Asset; movement: Movement }> =>
  apiRequest(`/inventory/assets/${encodeURIComponent(id)}/${action}`, { method: 'POST', body })
export const myAssets = (signal?: AbortSignal): Promise<{ assets: { id: string; assetTag: string; name: string; type: ProductType }[] }> => apiRequest('/inventory/assets/mine', { signal })

export const listMovements = (query: Query, signal?: AbortSignal): Promise<{ movements: Movement[]; pagination: Pagination }> => apiRequest(`/inventory/movements${qs(query)}`, { signal })
export const getInsights = (query: Query, signal?: AbortSignal): Promise<{ insights: Insights }> => apiRequest(`/inventory/insights${qs(query)}`, { signal })
export const getTicketMaterials = (ticketId: string, signal?: AbortSignal): Promise<{ materials: TicketMaterials }> => apiRequest(`/tickets/${encodeURIComponent(ticketId)}/materials`, { signal })

/** Business rules the API explains with a code, in the words people use. */
const INVENTORY_MESSAGES: Record<string, string> = {
  INSUFFICIENT_STOCK: 'Não há unidades disponíveis suficientes. Unidades reservadas não podem ser entregues sem a reserva.',
  NEGATIVE_BALANCE: 'A operação deixaria o saldo negativo.',
  BELOW_RESERVED: 'O ajuste deixaria menos unidades do que as já reservadas.',
  RESERVATION_CLOSED: 'Esta reserva já foi entregue ou cancelada.',
  ALREADY_REVERSED: 'Esta movimentação já foi estornada.',
  NOT_REVERSIBLE: 'Esta movimentação não pode ser estornada. Reservas são canceladas; entregas de reserva são corrigidas com uma devolução.',
  OPERATION_KEY_REUSED: 'Esta operação já foi registrada com outros dados. Recarregue a página e tente de novo.',
  STOCK_BUSY: 'O saldo deste item está sendo alterado agora. Tente de novo em instantes.',
  PRODUCT_INACTIVE: 'Este produto está inativo.',
  TRACKING_MISMATCH: 'Este produto usa outro modo de controle (quantidade ou patrimônio).',
  INVALID_TRANSITION: 'O equipamento não está em uma situação que permita esta ação. Os dados foram atualizados.',
  ASSET_TAG_TAKEN: 'Este número de patrimônio já está em uso.',
  SERIAL_TAKEN: 'Este número de série já está cadastrado para este modelo.',
}

export function inventoryErrorMessage(error: unknown, fallback: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined
  return (code && INVENTORY_MESSAGES[code]) || fallback
}
