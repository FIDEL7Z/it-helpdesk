import { useState, type FormEvent } from 'react'
import { useOperationKey } from '../../hooks/useOperationKey'
import { assetAction, inventoryErrorMessage, type Asset, type AssetActionName, type AssetStatus } from '../../services/inventory'
import type { Department, Person } from '../../services/organization'
import { getErrorMessage } from '../../utils/errors'
import { FormMessage, LocationFields, PersonSelect } from './InventoryUi'

const LABELS: Record<AssetActionName, string> = {
  reserve: 'Reservar para um chamado',
  'cancel-reservation': 'Cancelar reserva',
  assign: 'Entregar',
  transfer: 'Transferir',
  return: 'Devolver ao estoque',
  maintenance: 'Enviar para manutenção',
  defective: 'Registrar defeito',
  retire: 'Dar baixa',
}

/** Same transitions the API accepts; anything else is not offered. */
const ALLOWED: Record<AssetStatus, AssetActionName[]> = {
  available: ['assign', 'maintenance', 'defective', 'retire'],
  reserved: ['assign', 'cancel-reservation', 'maintenance', 'defective', 'retire'],
  in_use: ['transfer', 'return', 'maintenance', 'defective', 'retire'],
  in_maintenance: ['return', 'assign', 'defective', 'retire'],
  defective: ['maintenance', 'retire'],
  retired: [],
}

const NEEDS_PLACE = new Set<AssetActionName>(['assign', 'transfer'])
const NEEDS_REASON = new Set<AssetActionName>(['maintenance', 'defective', 'retire'])

export function AssetActionForm({ asset, departments, people, canRetire, ticketId, defaults, onDone, only }: {
  asset: Asset
  departments: Department[]
  people: Person[]
  canRetire: boolean
  ticketId?: string
  defaults?: { holderId?: string; departmentId?: string; roomId?: string; reason?: string }
  onDone: (asset: Asset) => void
  only?: AssetActionName[]
}) {
  const actions = ALLOWED[asset.status].filter((a) => (a !== 'retire' || canRetire) && (!only || only.includes(a)))
  const [action, setAction] = useState<AssetActionName | ''>(actions[0] ?? '')
  const [holderId, setHolderId] = useState(defaults?.holderId ?? '')
  const [place, setPlace] = useState({ departmentId: defaults?.departmentId ?? '', roomId: defaults?.roomId ?? '' })
  const [reason, setReason] = useState(defaults?.reason ?? '')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const key = useOperationKey()

  if (!actions.length) return <p className="text-muted">{asset.status === 'retired' ? 'Equipamento baixado: não há ações disponíveis.' : 'Nenhuma ação disponível.'}</p>

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!action) return
    if (NEEDS_PLACE.has(action) && !place.departmentId) { setMessage({ type: 'error', text: 'Informe o departamento de destino.' }); return }
    if (NEEDS_REASON.has(action) && reason.trim().length < 5) { setMessage({ type: 'error', text: 'Explique o motivo (pelo menos 5 caracteres).' }); return }
    setSaving(true)
    setMessage(null)
    try {
      const result = await assetAction(asset.id, action, {
        operationId: key.key, reason: reason.trim() || null, ...(ticketId && { ticketId }),
        ...(NEEDS_PLACE.has(action) && { departmentId: place.departmentId, roomId: place.roomId || null, holderId: holderId || null }),
      })
      key.renew()
      setMessage({ type: 'success', text: `${LABELS[action]}: registrado.` })
      onDone(result.asset)
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="form asset-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={`asset-action-${asset.id}`} className="field__label">Ação</label>
        <select id={`asset-action-${asset.id}`} className="field__input field__select" value={action} onChange={(e) => { setAction(e.target.value as AssetActionName); setMessage(null); key.renew() }}>
          {actions.map((a) => <option key={a} value={a}>{LABELS[a]}</option>)}
        </select>
      </div>
      {action && NEEDS_PLACE.has(action) && (
        <>
          <PersonSelect id={`asset-holder-${asset.id}`} people={people} value={holderId} onChange={setHolderId} label="Responsável pelo equipamento" />
          <LocationFields idPrefix={`asset-place-${asset.id}`} departments={departments} value={place} onChange={setPlace} legend="Para onde vai" required />
        </>
      )}
      <div className="field">
        <label htmlFor={`asset-reason-${asset.id}`} className="field__label">Motivo{action && NEEDS_REASON.has(action) ? '' : ' (opcional)'}</label>
        <input id={`asset-reason-${asset.id}`} className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </div>
      <FormMessage message={message} />
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>{saving ? 'Registrando...' : action ? LABELS[action] : 'Registrar'}</button>
      </div>
    </form>
  )
}
