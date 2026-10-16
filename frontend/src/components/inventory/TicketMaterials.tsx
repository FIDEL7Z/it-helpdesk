import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { useOperationKey } from '../../hooks/useOperationKey'
import { useResource } from '../../hooks/useResource'
import {
  assetAction,
  cancelReservation,
  getTicketMaterials,
  inventoryErrorMessage,
  listAssets,
  listProducts,
  stockAction,
  type Movement,
  type TicketMaterials as Materials,
} from '../../services/inventory'
import { getOrganization, listPeople, locationLabel, type Department, type Location, type Person } from '../../services/organization'
import { getErrorMessage } from '../../utils/errors'
import { formatDateTime } from '../../utils/format'
import { FormMessage, LocationFields, MovementList, PersonSelect } from './InventoryUi'

type TicketRef = { id: string; requesterId: string | null; location: Location | null; affectedAsset: { id?: string; assetTag: string; name: string } | null }

/**
 * Materials and equipment of a ticket. Registering a delivery never resolves the ticket, and
 * resolving never takes anything from the stock: they are separate decisions.
 */
export function TicketMaterials({ ticket }: { ticket: TicketRef }) {
  const { user } = useAuth()
  const materials = useResource((signal) => getTicketMaterials(ticket.id, signal), [ticket.id])
  const data = materials.data?.materials
  if (!data) return null
  if (data.view === 'requester') return data.deliveries.length ? <RequesterDeliveries deliveries={data.deliveries} /> : null
  return <TeamMaterials ticket={ticket} materials={data} canOperate={can(user?.role, 'inventory:operate')} onChange={materials.reload} />
}

function RequesterDeliveries({ deliveries }: { deliveries: Extract<Materials, { view: 'requester' }>['deliveries'] }) {
  return (
    <section className="card" aria-labelledby="delivered-title">
      <h2 id="delivered-title" className="card__title">Material entregue</h2>
      <ul className="delivery-list">
        {deliveries.map((d) => (
          <li key={d.id}>
            <strong>{d.quantity > 1 ? `${d.quantity} × ` : ''}{d.product.name}</strong>{d.assetTag && <> · patrimônio {d.assetTag}</>}
            <p className="text-muted">
              Entregue por {d.deliveredBy.name}{d.receivedByYou ? ' para você' : ''} em {formatDateTime(d.deliveredAt)}{d.location ? ` · ${locationLabel(d.location)}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

type Mode = 'material' | 'equipment' | 'removed' | null

function TeamMaterials({ ticket, materials, canOperate, onChange }: { ticket: TicketRef; materials: Extract<Materials, { view: 'team' }>; canOperate: boolean; onChange: () => void }) {
  const [mode, setMode] = useState<Mode>(null)
  const support = useResource(async (signal) => {
    if (!canOperate) return null
    const [org, people] = await Promise.all([getOrganization(signal), listPeople(signal)])
    return { departments: org.departments, people: people.people }
  }, [canOperate])
  const done = () => { setMode(null); onChange() }
  const defaults = {
    recipientId: ticket.requesterId ?? '',
    departmentId: ticket.location?.department.id ?? '',
    roomId: ticket.location?.room?.id ?? '',
  }

  return (
    <section className="card materials-panel" aria-labelledby="materials-title">
      <div className="card__header-row">
        <h2 id="materials-title" className="card__title">Materiais e equipamentos</h2>
        <Link to="/inventory">Abrir estoque</Link>
      </div>
      <p className="field__hint">Entregar material não resolve o chamado, e resolver o chamado não dá baixa no estoque.</p>
      {canOperate && (
        <div className="materials-panel__actions" role="group" aria-label="Registrar">
          <button type="button" className="button button--secondary button--small" aria-pressed={mode === 'material'} onClick={() => setMode(mode === 'material' ? null : 'material')}>Entregar material</button>
          <button type="button" className="button button--secondary button--small" aria-pressed={mode === 'equipment'} onClick={() => setMode(mode === 'equipment' ? null : 'equipment')}>Entregar equipamento</button>
          <button type="button" className="button button--secondary button--small" aria-pressed={mode === 'removed'} onClick={() => setMode(mode === 'removed' ? null : 'removed')}>Registrar item retirado</button>
        </div>
      )}
      {mode && support.data && (
        <div className="materials-panel__form">
          {mode === 'material' && <DeliverMaterial ticketId={ticket.id} departments={support.data.departments} people={support.data.people} defaults={defaults} onDone={done} />}
          {mode === 'equipment' && <DeliverEquipment ticketId={ticket.id} departments={support.data.departments} people={support.data.people} defaults={defaults} onDone={done} />}
          {mode === 'removed' && <RegisterRemoved ticket={ticket} onDone={done} />}
        </div>
      )}
      {materials.openReservations.length > 0 && (
        <>
          <h3 className="card__subtitle">Reservado para este chamado</h3>
          <MovementList movements={materials.openReservations} empty="" action={canOperate ? (m) => <ReservationButtons reservation={m} onDone={onChange} /> : undefined} />
        </>
      )}
      {materials.reservedAssets.length > 0 && (
        <p>Equipamentos reservados: {materials.reservedAssets.map((a) => <Link key={a.id} to={`/inventory/assets/${a.id}`}>{a.assetTag}</Link>)}</p>
      )}
      <h3 className="card__subtitle">Movimentações deste chamado</h3>
      <MovementList movements={materials.movements} empty="Nenhum material ou equipamento movimentado neste chamado." />
    </section>
  )
}

function DeliverMaterial({ ticketId, departments, people, defaults, onDone }: {
  ticketId: string; departments: Department[]; people: Person[]; defaults: { recipientId: string; departmentId: string; roomId: string }; onDone: () => void
}) {
  const products = useResource((signal) => listProducts({ tracking: 'quantity', limit: 100 }, signal), [])
  const [productId, setProductId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [reserveOnly, setReserveOnly] = useState(false)
  const [recipientId, setRecipientId] = useState(defaults.recipientId)
  const [place, setPlace] = useState({ departmentId: defaults.departmentId, roomId: defaults.roomId })
  const [reason, setReason] = useState('Substituição de equipamento com defeito')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const key = useOperationKey()
  const product = products.data?.products.find((p) => p.id === productId)
  const available = product?.stock?.available ?? 0
  const noStock = Boolean(products.data && products.data.products.every((p) => (p.stock?.available ?? 0) === 0))

  async function submit(event: FormEvent) {
    event.preventDefault()
    const amount = Number(quantity)
    if (!product) { setMessage({ type: 'error', text: 'Escolha o material.' }); return }
    if (!Number.isInteger(amount) || amount < 1) { setMessage({ type: 'error', text: 'Informe uma quantidade inteira a partir de 1.' }); return }
    if (amount > available) { setMessage({ type: 'error', text: `Só há ${available} unidade(s) disponível(is) de ${product.name}.` }); return }
    setSaving(true)
    setMessage(null)
    try {
      await stockAction(product.id, reserveOnly ? 'reservations' : 'issues', {
        operationId: key.key, quantity: amount, ticketId, reason: reason.trim() || null,
        recipientId: recipientId || null, departmentId: place.departmentId || null, roomId: place.roomId || null,
      })
      key.renew()
      onDone()
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
      products.reload()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate aria-label="Entregar material">
      {noStock && <p className="alert alert--warning" role="status">Nenhum material com unidades disponíveis no estoque.</p>}
      <div className="form__row">
        <div className="field">
          <label htmlFor="deliver-product" className="field__label">Material</label>
          <select id="deliver-product" className="field__input field__select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Selecione</option>
            {products.data?.products.map((p) => (
              <option key={p.id} value={p.id} disabled={(p.stock?.available ?? 0) === 0}>{p.name} — {p.stock?.available ?? 0} disponível(is)</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="deliver-quantity" className="field__label">Quantidade</label>
          <input id="deliver-quantity" className="field__input" type="number" min={1} max={available || undefined} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
      </div>
      {product && Object.keys(product.attributes).length > 0 && (
        <p className="field__hint">Características: {Object.entries(product.attributes).map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? 'sim' : 'não') : v}`).join(' · ')}</p>
      )}
      <PersonSelect id="deliver-recipient" people={people} value={recipientId} onChange={setRecipientId} />
      <LocationFields idPrefix="deliver-place" departments={departments} value={place} onChange={setPlace} legend="Onde foi entregue" />
      <div className="field">
        <label htmlFor="deliver-reason" className="field__label">Motivo</label>
        <input id="deliver-reason" className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </div>
      <label className="checkbox" htmlFor="deliver-reserve"><input id="deliver-reserve" type="checkbox" checked={reserveOnly} onChange={(e) => setReserveOnly(e.target.checked)} /> Só reservar agora (entregar depois)</label>
      <FormMessage message={message} />
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>{saving ? 'Registrando...' : reserveOnly ? 'Reservar material' : 'Registrar entrega'}</button>
      </div>
    </form>
  )
}

function DeliverEquipment({ ticketId, departments, people, defaults, onDone }: {
  ticketId: string; departments: Department[]; people: Person[]; defaults: { recipientId: string; departmentId: string; roomId: string }; onDone: () => void
}) {
  const assets = useResource((signal) => listAssets({ status: 'available', limit: 100 }, signal), [])
  const [assetId, setAssetId] = useState('')
  const [holderId, setHolderId] = useState(defaults.recipientId)
  const [place, setPlace] = useState({ departmentId: defaults.departmentId, roomId: defaults.roomId })
  const [reason, setReason] = useState('Entrega para o atendimento')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const key = useOperationKey()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!assetId) { setMessage({ type: 'error', text: 'Escolha o equipamento.' }); return }
    if (!place.departmentId) { setMessage({ type: 'error', text: 'Informe o departamento de destino.' }); return }
    try {
      await assetAction(assetId, 'assign', { operationId: key.key, ticketId, holderId: holderId || null, departmentId: place.departmentId, roomId: place.roomId || null, reason: reason.trim() || null })
      key.renew()
      onDone()
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
      assets.reload()
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate aria-label="Entregar equipamento">
      {assets.data?.assets.length === 0 && <p className="alert alert--warning" role="status">Nenhum equipamento disponível no estoque.</p>}
      <div className="field">
        <label htmlFor="deliver-asset" className="field__label">Equipamento disponível</label>
        <select id="deliver-asset" className="field__input field__select" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          <option value="">Selecione</option>
          {assets.data?.assets.map((a) => <option key={a.id} value={a.id}>{a.assetTag} — {a.product?.name}</option>)}
        </select>
      </div>
      <PersonSelect id="deliver-holder" people={people} value={holderId} onChange={setHolderId} label="Responsável pelo equipamento" />
      <LocationFields idPrefix="deliver-asset-place" departments={departments} value={place} onChange={setPlace} legend="Onde fica" required />
      <div className="field">
        <label htmlFor="deliver-asset-reason" className="field__label">Motivo</label>
        <input id="deliver-asset-reason" className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </div>
      <FormMessage message={message} />
      <div className="form__actions"><button type="submit" className="button button--primary">Registrar entrega do equipamento</button></div>
    </form>
  )
}

/** The broken item taken back: an asset becomes defective; a plain peripheral is recorded without inventing an identity. */
function RegisterRemoved({ ticket, onDone }: { ticket: TicketRef; onDone: () => void }) {
  const inUse = useResource((signal) => ticket.requesterId ? listAssets({ holderId: ticket.requesterId, status: 'in_use', limit: 50 }, signal) : Promise.resolve(null), [ticket.requesterId])
  const products = useResource((signal) => listProducts({ tracking: 'quantity', limit: 100 }, signal), [])
  const [kind, setKind] = useState<'asset' | 'material'>(ticket.affectedAsset ? 'asset' : 'material')
  const [assetId, setAssetId] = useState(ticket.affectedAsset?.id ?? '')
  const [productId, setProductId] = useState('')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const key = useOperationKey()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (reason.trim().length < 5) { setMessage({ type: 'error', text: 'Descreva o defeito (pelo menos 5 caracteres).' }); return }
    try {
      if (kind === 'asset') {
        if (!assetId) { setMessage({ type: 'error', text: 'Escolha o equipamento retirado.' }); return }
        await assetAction(assetId, 'defective', { operationId: key.key, ticketId: ticket.id, reason: reason.trim() })
      } else {
        if (!productId) { setMessage({ type: 'error', text: 'Escolha o material.' }); return }
        await stockAction(productId, 'returns', { operationId: key.key, quantity: 1, condition: 'defective', ticketId: ticket.id, recipientId: ticket.requesterId, departmentId: ticket.location?.department.id ?? null, roomId: ticket.location?.room?.id ?? null, reason: reason.trim() })
      }
      key.renew()
      onDone()
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate aria-label="Registrar item retirado">
      <div className="segmented" role="group" aria-label="O que foi retirado">
        <button type="button" className="segmented__option" aria-pressed={kind === 'asset'} onClick={() => setKind('asset')}>Equipamento com patrimônio</button>
        <button type="button" className="segmented__option" aria-pressed={kind === 'material'} onClick={() => setKind('material')}>Periférico sem patrimônio</button>
      </div>
      {kind === 'asset' ? (
        <div className="field">
          <label htmlFor="removed-asset" className="field__label">Equipamento</label>
          <select id="removed-asset" className="field__input field__select" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">Selecione</option>
            {ticket.affectedAsset?.id && <option value={ticket.affectedAsset.id}>{ticket.affectedAsset.assetTag} — {ticket.affectedAsset.name} (informado no pedido)</option>}
            {inUse.data?.assets.filter((a) => a.id !== ticket.affectedAsset?.id).map((a) => <option key={a.id} value={a.id}>{a.assetTag} — {a.product?.name}</option>)}
          </select>
          <p className="field__hint">Fica registrado como defeituoso, com o local de onde saiu.</p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="removed-product" className="field__label">Material</label>
          <select id="removed-product" className="field__input field__select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Selecione</option>
            {products.data?.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <p className="field__hint">Uma unidade com defeito fica separada no almoxarifado, sem número de patrimônio.</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="removed-reason" className="field__label">Defeito encontrado</label>
        <input id="removed-reason" className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: teclas sem resposta" />
      </div>
      <FormMessage message={message} />
      <div className="form__actions"><button type="submit" className="button button--primary">Registrar item retirado</button></div>
    </form>
  )
}

function ReservationButtons({ reservation, onDone }: { reservation: Movement; onDone: () => void }) {
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const key = useOperationKey()
  const productId = reservation.product?.id ?? ''
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
