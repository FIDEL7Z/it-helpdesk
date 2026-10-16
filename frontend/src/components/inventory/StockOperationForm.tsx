import { useState, type FormEvent } from 'react'
import { useOperationKey } from '../../hooks/useOperationKey'
import { getErrorMessage } from '../../utils/errors'
import { inventoryErrorMessage, stockAction, type Product, type StockAction } from '../../services/inventory'
import type { Department, Person } from '../../services/organization'
import { FormMessage, LocationFields, PersonSelect } from './InventoryUi'

type Operation = 'receipts' | 'issues' | 'returns' | 'adjustments' | 'discards'
const LABELS: Record<Operation, string> = { receipts: 'Entrada', issues: 'Entrega', returns: 'Devolução', adjustments: 'Ajuste de inventário', discards: 'Descarte' }

/** The store-room operations of a product counted by quantity, one at a time. */
export function StockOperationForm({ product, departments, people, canAdjust, onDone, ticketId, defaults }: {
  product: Product
  departments: Department[]
  people: Person[]
  canAdjust: boolean
  onDone: (product: Product) => void
  ticketId?: string
  defaults?: { recipientId?: string; departmentId?: string; roomId?: string; reason?: string }
}) {
  const operations: Operation[] = ['receipts', 'issues', 'returns', ...(canAdjust ? ['adjustments', 'discards'] as Operation[] : [])]
  const [operation, setOperation] = useState<Operation>('receipts')
  const [quantity, setQuantity] = useState('1')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState(defaults?.reason ?? '')
  const [condition, setCondition] = useState<'good' | 'defective'>('good')
  const [recipientId, setRecipientId] = useState(defaults?.recipientId ?? '')
  const [place, setPlace] = useState({ departmentId: defaults?.departmentId ?? '', roomId: defaults?.roomId ?? '' })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const operationKey = useOperationKey()
  const available = product.stock?.available ?? 0
  const needsReason = operation === 'adjustments' || operation === 'discards'

  function choose(next: Operation) {
    setOperation(next)
    setMessage(null)
    operationKey.renew()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const amount = Number(quantity)
    if (operation !== 'adjustments' && (!Number.isInteger(amount) || amount < 1)) { setMessage({ type: 'error', text: 'Informe uma quantidade inteira a partir de 1.' }); return }
    if (operation === 'adjustments' && (!Number.isInteger(Number(delta)) || Number(delta) === 0)) { setMessage({ type: 'error', text: 'Informe quantas unidades somar (ex.: 2) ou tirar (ex.: -2).' }); return }
    if (needsReason && reason.trim().length < 5) { setMessage({ type: 'error', text: 'Explique o motivo (pelo menos 5 caracteres).' }); return }
    if (operation === 'issues' && amount > available) { setMessage({ type: 'error', text: `Só há ${available} unidade(s) disponível(is).` }); return }
    const where = place.departmentId || place.roomId ? { departmentId: place.departmentId || null, roomId: place.roomId || null } : {}
    const body: Record<string, unknown> = { operationId: operationKey.key, reason: reason.trim() || (needsReason ? undefined : null) }
    if (operation === 'adjustments') body.delta = Number(delta)
    else body.quantity = amount
    if (operation === 'issues' || operation === 'returns') Object.assign(body, where, recipientId ? { recipientId } : {}, ticketId ? { ticketId } : {})
    if (operation === 'returns') body.condition = condition
    setSaving(true)
    setMessage(null)
    try {
      const result = await stockAction(product.id, operation as StockAction, body)
      operationKey.renew()
      setMessage({ type: 'success', text: `${LABELS[operation]} registrada. Disponível agora: ${result.product.stock?.available ?? 0}.` })
      setReason(defaults?.reason ?? '')
      onDone(result.product)
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="form stock-form" onSubmit={submit} noValidate>
      <div className="segmented" role="group" aria-label="Operação">
        {operations.map((op) => <button key={op} type="button" className="segmented__option" aria-pressed={operation === op} onClick={() => choose(op)}>{LABELS[op]}</button>)}
      </div>
      {operation === 'issues' && available === 0 && <p className="alert alert--warning" role="status">Sem unidades disponíveis deste material.</p>}
      <div className="form__row">
        {operation === 'adjustments' ? (
          <div className="field">
            <label htmlFor="stock-delta" className="field__label">Somar ou tirar unidades</label>
            <input id="stock-delta" className="field__input" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="Ex.: -2" aria-describedby="stock-delta-hint" />
            <p id="stock-delta-hint" className="field__hint">Corrige a contagem física. Fica no histórico com o motivo.</p>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="stock-quantity" className="field__label">Quantidade</label>
            <input id="stock-quantity" className="field__input" type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
        )}
        {operation === 'returns' && (
          <div className="field">
            <label htmlFor="stock-condition" className="field__label">Estado</label>
            <select id="stock-condition" className="field__input field__select" value={condition} onChange={(e) => setCondition(e.target.value as 'good' | 'defective')}>
              <option value="good">Em bom estado (volta a ficar disponível)</option>
              <option value="defective">Com defeito (fica separado)</option>
            </select>
          </div>
        )}
      </div>
      {(operation === 'issues' || operation === 'returns') && (
        <>
          <PersonSelect id="stock-recipient" people={people} value={recipientId} onChange={setRecipientId} label={operation === 'issues' ? 'Quem recebe' : 'De quem veio'} />
          <LocationFields idPrefix="stock-place" departments={departments} value={place} onChange={setPlace} legend={operation === 'issues' ? 'Onde foi entregue' : 'De onde veio'} />
        </>
      )}
      <div className="field">
        <label htmlFor="stock-reason" className="field__label">Motivo{needsReason ? '' : ' (opcional)'}</label>
        <input id="stock-reason" className="field__input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={operation === 'receipts' ? 'Ex.: compra de reposição' : 'Ex.: substituição de teclado com defeito'} />
      </div>
      <FormMessage message={message} />
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>{saving ? 'Registrando...' : `Registrar ${LABELS[operation].toLowerCase()}`}</button>
      </div>
    </form>
  )
}
