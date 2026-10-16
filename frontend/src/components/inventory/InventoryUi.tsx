import { Link, NavLink } from 'react-router'
import type { ReactNode } from 'react'
import { ASSET_STATUS_LABELS, type AssetStatus, type Movement } from '../../services/inventory'
import type { Department, Person } from '../../services/organization'
import { movementSummary } from './movement-summary'
import { formatDateTime } from '../../utils/format'

/** Sections of the stock module, kept to the pages that exist. */
export function InventoryNav() {
  const tabs: [string, string][] = [
    ['/inventory', 'Visão geral'],
    ['/inventory/products', 'Materiais'],
    ['/inventory/assets', 'Equipamentos'],
    ['/inventory/movements', 'Movimentações'],
    ['/inventory/organization', 'Departamentos e salas'],
  ]
  return (
    <nav className="inventory-nav" aria-label="Estoque e patrimônio">
      {tabs.map(([to, label]) => <NavLink key={to} to={to} end={to === '/inventory'} className="inventory-nav__link">{label}</NavLink>)}
    </nav>
  )
}

export function AssetStatusBadge({ status }: { status: AssetStatus }) {
  return <span className={`asset-status asset-status--${status}`}>{ASSET_STATUS_LABELS[status]}</span>
}

export function DemoTag({ origin }: { origin: 'operational' | 'demo' }) {
  return origin === 'demo' ? <span className="origin-tag origin-tag--demo">Demonstração</span> : null
}

/** Ledger rows as a compact, readable list (who, what, when, why, which ticket). */
export function MovementList({ movements, empty, showProduct = true, action }: {
  movements: Movement[]
  empty: string
  showProduct?: boolean
  action?: (movement: Movement) => ReactNode
}) {
  if (!movements.length) return <p className="text-muted">{empty}</p>
  return (
    <ol className="movement-list">
      {movements.map((movement) => (
        <li key={movement.id} className={`movement-list__item${movement.reversedBy ? ' movement-list__item--reversed' : ''}`}>
          <p className="movement-list__what">
            <strong>{movementSummary(movement)}</strong>
            {showProduct && movement.product && <> — <Link to={movement.asset ? `/inventory/assets/${movement.asset.id}` : `/inventory/products/${movement.product.id}`}>{movement.asset ? `${movement.asset.assetTag} · ${movement.product.name}` : movement.product.name}</Link></>}
            {movement.reversedBy && <span className="attention-tag">Estornada</span>}
            <DemoTag origin={movement.dataOrigin} />
          </p>
          {movement.reason && <p className="movement-list__reason">Motivo: {movement.reason}</p>}
          <p className="movement-list__meta">
            Registrado por {movement.actor.name} · <time dateTime={movement.occurredAt}>{formatDateTime(movement.occurredAt)}</time>
            {movement.ticket && <> · <Link to={`/tickets/${movement.ticket.id}`}>Chamado: {movement.ticket.title}</Link></>}
            {' · '}Registro nº {movement.sequence}
          </p>
          {action?.(movement)}
        </li>
      ))}
    </ol>
  )
}

/** Department and room, from the active company structure; the room list follows the department. */
export function LocationFields({ departments, value, onChange, idPrefix, required = false, legend = 'Local' }: {
  departments: Department[]
  value: { departmentId: string; roomId: string }
  onChange: (value: { departmentId: string; roomId: string }) => void
  idPrefix: string
  required?: boolean
  legend?: string
}) {
  const rooms = departments.find((d) => d.id === value.departmentId)?.rooms.filter((r) => r.active) ?? []
  return (
    <fieldset className="location-fields">
      <legend className="field__label">{legend}</legend>
      <div className="form__row">
        <div className="field">
          <label htmlFor={`${idPrefix}-department`} className="field__label">Departamento</label>
          <select id={`${idPrefix}-department`} className="field__input field__select" value={value.departmentId} required={required}
            onChange={(event) => onChange({ departmentId: event.target.value, roomId: '' })}>
            <option value="">{required ? 'Selecione' : 'Não informado'}</option>
            {departments.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-room`} className="field__label">Sala</label>
          <select id={`${idPrefix}-room`} className="field__input field__select" value={value.roomId} disabled={!rooms.length}
            onChange={(event) => onChange({ ...value, roomId: event.target.value })}>
            <option value="">{rooms.length ? 'Não informada' : 'Sem salas cadastradas'}</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>
    </fieldset>
  )
}

export function PersonSelect({ people, value, onChange, id, label = 'Quem recebe' }: {
  people: Person[]; value: string; onChange: (id: string) => void; id: string; label?: string
}) {
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">{label}</label>
      <select id={id} className="field__input field__select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Ninguém em particular</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` — ${p.department.name}` : ''}</option>)}
      </select>
    </div>
  )
}

/** A form message that also announces itself to screen readers. */
export function FormMessage({ message }: { message: { type: 'success' | 'error'; text: string } | null }) {
  if (!message) return null
  return <p className={`alert alert--${message.type === 'success' ? 'success' : 'error'}`} role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</p>
}
