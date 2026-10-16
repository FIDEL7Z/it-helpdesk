import { useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { AssetStatusBadge, FormMessage, InventoryNav, MovementList } from '../../components/inventory/InventoryUi'
import { ProductForm } from '../../components/inventory/ProductForm'
import { StockOperationForm } from '../../components/inventory/StockOperationForm'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useOperationKey } from '../../hooks/useOperationKey'
import { useResource } from '../../hooks/useResource'
import {
  cancelReservation,
  getProduct,
  getProductTypes,
  inventoryErrorMessage,
  listAssets,
  listMovements,
  stockAction,
  TRACKING_LABELS,
  type Movement,
} from '../../services/inventory'
import { getOrganization, listPeople, locationLabel } from '../../services/organization'
import { getErrorMessage } from '../../utils/errors'

export function ProductDetailPage() {
  const { user } = useAuth()
  return can(user?.role, 'inventory:read') ? <ProductDetail /> : <Navigate to="/dashboard" replace />
}

const REVERSIBLE = new Set(['receipt', 'issue', 'return', 'adjustment', 'discard'])

function ProductDetail() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const location = useLocation()
  const canOperate = can(user?.role, 'inventory:operate')
  const canAdjust = can(user?.role, 'inventory:adjust')
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(
    (location.state as { created?: boolean } | null)?.created ? { type: 'success', text: 'Material cadastrado.' } : null,
  )

  const detail = useResource((signal) => getProduct(id, signal), [id])
  const catalog = useResource((signal) => getProductTypes(signal), [])
  const movements = useResource((signal) => listMovements({ productId: id, limit: 30 }, signal), [id])
  const support = useResource(async (signal) => {
    const [org, people] = await Promise.all([getOrganization(signal), listPeople(signal)])
    return { departments: org.departments, people: people.people }
  }, [])
  const product = detail.data?.product
  const assets = useResource((signal) => product?.tracking === 'asset' ? listAssets({ productId: id, limit: 50 }, signal) : Promise.resolve(null), [id, product?.tracking])
  useDocumentTitle(product?.name ?? 'Material')

  function refresh() {
    detail.reload()
    movements.reload()
  }

  if (detail.error) return <section className="page"><InventoryNav /><div className="alert alert--error" role="alert"><p>{detail.error}</p></div></section>
  if (!product) return <section className="page"><div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando material...</div></section>
  const types = catalog.data?.types
  const specs = types?.[product.type].attributes ?? []

  return (
    <section className="page inventory-page">
      <Link to="/inventory/products" className="back-link">← Voltar aos materiais</Link>
      <header className="page__header page__header--with-action">
        <div>
          <p className="eyebrow">{types?.[product.type].label ?? product.type} · {TRACKING_LABELS[product.tracking]}</p>
          <h1 className="page__title">{product.name}</h1>
          <p className="page__subtitle">{[product.brand, product.model, product.sku && `SKU ${product.sku}`].filter(Boolean).join(' · ') || 'Sem marca ou modelo informados'}</p>
        </div>
        {canOperate && !editing && types && <button type="button" className="button button--secondary" onClick={() => setEditing(true)}>Editar cadastro</button>}
      </header>
      <InventoryNav />
      <FormMessage message={notice} />
      {!product.active && <p className="alert alert--warning">Material inativo: não recebe entradas nem entregas.</p>}

      {editing && types && (
        <ProductForm catalog={types} product={product} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setNotice({ type: 'success', text: 'Cadastro atualizado.' }); detail.reload() }} />
      )}

      <div className="inventory-columns">
        <section className="card" aria-labelledby="product-balance">
          <h2 id="product-balance" className="card__title">{product.tracking === 'quantity' ? 'Saldo no almoxarifado' : 'Unidades por situação'}</h2>
          {product.stock ? (
            <dl className="balance">
              <div><dt>Disponível</dt><dd className="balance__main">{product.stock.available}</dd></div>
              <div><dt>Reservado</dt><dd>{product.stock.reserved}</dd></div>
              <div><dt>No almoxarifado</dt><dd>{product.stock.onHand}</dd></div>
              <div><dt>Com defeito, separado</dt><dd>{product.stock.defective}</dd></div>
              <div><dt>Mínimo</dt><dd>{product.minStock}</dd></div>
            </dl>
          ) : (
            <dl className="balance">
              {(['available', 'reserved', 'in_use', 'in_maintenance', 'defective', 'retired'] as const).map((status) => (
                <div key={status}><dt><AssetStatusBadge status={status} /></dt><dd>{product.assets?.[status] ?? 0}</dd></div>
              ))}
              <div><dt>Mínimo disponível</dt><dd>{product.minStock}</dd></div>
            </dl>
          )}
          {product.belowMinimum && <p className="attention-tag">Abaixo do estoque mínimo</p>}
        </section>
        <section className="card" aria-labelledby="product-attributes">
          <h2 id="product-attributes" className="card__title">Características</h2>
          {specs.filter((s) => product.attributes[s.key] !== undefined).length === 0 ? <p className="text-muted">Nenhuma característica informada.</p> : (
            <dl className="details details--compact">
              {specs.filter((s) => product.attributes[s.key] !== undefined).map((s) => {
                const value = product.attributes[s.key]
                return <div key={s.key} className="details__row"><dt>{s.label}</dt><dd>{typeof value === 'boolean' ? (value ? 'Sim' : 'Não') : `${value}${'unit' in s && s.unit ? ` ${s.unit}` : ''}`}</dd></div>
              })}
            </dl>
          )}
          {product.description && <p>{product.description}</p>}
        </section>
      </div>

      {product.tracking === 'quantity' && canOperate && support.data && (
        <section className="card" aria-labelledby="stock-operations">
          <h2 id="stock-operations" className="card__title">Registrar movimentação</h2>
          <StockOperationForm product={product} departments={support.data.departments} people={support.data.people} canAdjust={canAdjust} onDone={() => refresh()} />
        </section>
      )}

      {product.tracking === 'quantity' && detail.data && detail.data.openReservations.length > 0 && (
        <section className="card" aria-labelledby="open-reservations">
          <h2 id="open-reservations" className="card__title">Reservas em aberto</h2>
          <MovementList movements={detail.data.openReservations} showProduct={false} empty="" action={canOperate ? (m) => <ReservationActions productId={product.id} reservation={m} onDone={refresh} /> : undefined} />
        </section>
      )}

      {product.tracking === 'asset' && (
        <section className="card" aria-labelledby="product-assets">
          <div className="card__header-row">
            <h2 id="product-assets" className="card__title">Equipamentos deste modelo</h2>
            {canOperate && <Link to={`/inventory/assets?new=1&productId=${product.id}`} className="button button--secondary button--small">Cadastrar equipamento</Link>}
          </div>
          {!assets.data || assets.data.assets.length === 0 ? <p className="text-muted">Nenhum equipamento cadastrado.</p> : (
            <ul className="plain-list">
              {assets.data.assets.map((a) => <li key={a.id}><Link to={`/inventory/assets/${a.id}`}>{a.assetTag}</Link> <AssetStatusBadge status={a.status} /> <span className="text-muted">{a.location ? locationLabel(a.location) : ''}{a.holder ? ` · ${a.holder.name}` : ''}</span></li>)}
            </ul>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="product-history">
        <h2 id="product-history" className="card__title">Histórico de movimentações</h2>
        <MovementList movements={movements.data?.movements ?? []} showProduct={product.tracking === 'asset'} empty="Nenhuma movimentação registrada."
          action={canAdjust && product.tracking === 'quantity' ? (m) => REVERSIBLE.has(m.type) && !m.reversedBy && !m.closes ? <ReverseAction productId={product.id} movement={m} onDone={refresh} /> : null : undefined} />
      </section>
    </section>
  )
}

function ReservationActions({ productId, reservation, onDone }: { productId: string; reservation: Movement; onDone: () => void }) {
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const key = useOperationKey()
  async function run(kind: 'deliver' | 'cancel') {
    try {
      if (kind === 'deliver') {
        await stockAction(productId, 'issues', { operationId: key.key, quantity: reservation.quantity, reservationId: reservation.id, ticketId: reservation.ticket?.id ?? null, recipientId: reservation.recipient?.id ?? null, departmentId: reservation.location?.department.id ?? null, roomId: reservation.location?.room?.id ?? null })
      } else {
        await cancelReservation(productId, reservation.id, { operationId: key.key })
      }
      key.renew()
      onDone()
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
    }
  }
  return (
    <div className="movement-list__actions">
      <button type="button" className="button button--secondary button--small" onClick={() => run('deliver')}>Entregar reservado</button>
      <button type="button" className="button button--ghost button--small" onClick={() => run('cancel')}>Cancelar reserva</button>
      <FormMessage message={message} />
    </div>
  )
}

/** Compensating entry: the original stays in the ledger, the reversal points to it. */
function ReverseAction({ productId, movement, onDone }: { productId: string; movement: Movement; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const key = useOperationKey()
  async function submit() {
    if (reason.trim().length < 5) { setMessage({ type: 'error', text: 'Explique o motivo do estorno (pelo menos 5 caracteres).' }); return }
    try {
      await stockAction(productId, 'reversals', { operationId: key.key, movementId: movement.id, reason: reason.trim() })
      key.renew()
      onDone()
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
    }
  }
  return (
    <details className="movement-list__reverse">
      <summary>Estornar</summary>
      <div className="form__row">
        <div className="field">
          <label htmlFor={`reverse-${movement.id}`} className="field__label">Motivo do estorno</label>
          <input id={`reverse-${movement.id}`} className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </div>
        <button type="button" className="button button--secondary button--small" onClick={submit}>Confirmar estorno</button>
      </div>
      <FormMessage message={message} />
    </details>
  )
}
