import { MOVEMENT_LABELS, type Movement } from '../../services/inventory'
import { locationLabel } from '../../services/organization'

/** One line that says what happened: "Entrega · 1 un. · para Maria · Financeiro — Sala 203". */
export function movementSummary(movement: Movement): string {
  const parts = [MOVEMENT_LABELS[movement.type]]
  if (movement.kind === 'quantity') parts.push(`${movement.type === 'adjustment' ? signedDelta(movement) : movement.quantity} un.`)
  if (movement.condition === 'defective') parts.push('com defeito')
  if (movement.recipient) parts.push(`${movement.type === 'return' ? 'de' : 'para'} ${movement.recipient.name}`)
  if (movement.location) parts.push(locationLabel(movement.location))
  else if (movement.fromLocation && movement.kind === 'asset') parts.push(`retirado de ${locationLabel(movement.fromLocation)}`)
  return parts.join(' · ')
}

function signedDelta(movement: Movement): string {
  const before = Number(movement.before.onHand ?? 0)
  const after = Number(movement.after.onHand ?? 0)
  return after >= before ? `+${after - before}` : `−${before - after}`
}
