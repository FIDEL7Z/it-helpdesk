import { Link, Navigate, useSearchParams } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { DemoTag, InventoryNav } from '../../components/inventory/InventoryUi'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useResource } from '../../hooks/useResource'
import { listMovements, MOVEMENT_LABELS, type Movement, type MovementType } from '../../services/inventory'
import { getOrganization, locationLabel } from '../../services/organization'
import { formatDateTime } from '../../utils/format'

/** The ledger: every movement, newest first, traceable to its product, asset, ticket and author. */
export function MovementsPage() {
  const { user } = useAuth()
  return can(user?.role, 'inventory:read') ? <Movements /> : <Navigate to="/dashboard" replace />
}

const FILTERABLE: MovementType[] = ['receipt', 'issue', 'reserve', 'reservation_cancel', 'return', 'adjustment', 'discard', 'reversal', 'asset_register', 'asset_assign', 'asset_transfer', 'asset_return', 'asset_maintenance', 'asset_defective', 'asset_retire']

function Movements() {
  useDocumentTitle('Movimentações')
  const [params, setParams] = useSearchParams()
  const type = params.get('type') ?? ''
  const departmentId = params.get('departmentId') ?? ''
  const days = params.get('days') ?? ''
  const page = Math.max(1, Number(params.get('page')) || 1)
  const list = useResource((signal) => {
    const from = days ? new Date(Date.now() - Number(days) * 86_400_000).toISOString() : undefined
    return listMovements({ type, departmentId, from, page, limit: 25 }, signal)
  }, [type, departmentId, days, page])
  const org = useResource((signal) => getOrganization(signal), [])

  function update(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    next.delete('page')
    setParams(next)
  }

  return (
    <section className="page inventory-page">
      <header className="page__header">
        <h1 className="page__title">Movimentações</h1>
        <p className="page__subtitle">Registro imutável: correções aparecem como estornos ou ajustes, nunca como edição.</p>
      </header>
      <InventoryNav />
      <div className="queue-panel">
        <div className="toolbar__filters">
          <div className="filter">
            <label htmlFor="movement-type" className="filter__label">Operação</label>
            <select id="movement-type" className="field__input field__select" value={type} onChange={(e) => update('type', e.target.value)}>
              <option value="">Todas</option>
              {FILTERABLE.map((t) => <option key={t} value={t}>{MOVEMENT_LABELS[t]}</option>)}
            </select>
          </div>
          <div className="filter">
            <label htmlFor="movement-department" className="filter__label">Departamento</label>
            <select id="movement-department" className="field__input field__select" value={departmentId} onChange={(e) => update('departmentId', e.target.value)}>
              <option value="">Todos</option>
              {org.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="filter">
            <label htmlFor="movement-days" className="filter__label">Período</label>
            <select id="movement-days" className="field__input field__select" value={days} onChange={(e) => update('days', e.target.value)}>
              <option value="">Desde o início</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option>
            </select>
          </div>
        </div>
      </div>

      {list.error ? (
        <div className="alert alert--error" role="alert"><p>{list.error}</p><button type="button" className="button button--secondary" onClick={list.reload}>Tentar novamente</button></div>
      ) : list.loading && !list.data ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando movimentações...</div>
      ) : list.data && list.data.movements.length === 0 ? (
        <div className="card card--empty"><p>Nenhuma movimentação com esses filtros.</p></div>
      ) : list.data && (
        <div className={`card card--table${list.loading ? ' is-loading' : ''}`} aria-busy={list.loading}>
          <table className="ticket-table inventory-table">
            <caption className="sr-only">Movimentações de estoque e patrimônio</caption>
            <thead><tr><th scope="col">Data</th><th scope="col">Operação</th><th scope="col">Material</th><th scope="col">Qtd.</th><th scope="col">Origem → destino</th><th scope="col">Técnico</th><th scope="col">Chamado</th></tr></thead>
            <tbody>
              {list.data.movements.map((m) => (
                <tr key={m.id}>
                  <td data-label="Data" className="ticket-table__date"><time dateTime={m.occurredAt}>{formatDateTime(m.occurredAt)}</time></td>
                  <td data-label="Operação">
                    {MOVEMENT_LABELS[m.type]}{m.condition === 'defective' ? ' (com defeito)' : ''}
                    {m.reversedBy && <span className="attention-tag">Estornada</span>}
                    <DemoTag origin={m.dataOrigin} />
                    {m.reason && <span className="table-sub">{m.reason}</span>}
                  </td>
                  <td data-label="Material">{m.product ? <Link to={m.asset ? `/inventory/assets/${m.asset.id}` : `/inventory/products/${m.product.id}`}>{m.asset ? `${m.asset.assetTag} · ` : ''}{m.product.name}</Link> : '—'}</td>
                  <td data-label="Qtd.">{m.quantity}</td>
                  <td data-label="Origem → destino">{originOf(m)} → {destinationOf(m)}</td>
                  <td data-label="Técnico">{m.actor.name}</td>
                  <td data-label="Chamado">{m.ticket ? <Link to={`/tickets/${m.ticket.id}`}>{m.ticket.title}</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.pagination.totalPages > 1 && (
        <nav className="pagination" aria-label="Paginação das movimentações">
          <span className="pagination__info">Página {page} de {list.data.pagination.totalPages}</span>
          <div className="pagination__actions">
            <button type="button" className="button button--secondary" disabled={page <= 1} onClick={() => update('page', String(page - 1))}>Anterior</button>
            <button type="button" className="button button--secondary" disabled={page >= list.data.pagination.totalPages} onClick={() => update('page', String(page + 1))}>Próxima</button>
          </div>
        </nav>
      )}
    </section>
  )
}

/** Where units or equipment came from: the store room, a person or a place. */
function originOf(m: Movement): string {
  if (m.kind === 'asset') return m.fromLocation ? locationLabel(m.fromLocation) : m.type === 'asset_register' ? 'Cadastro' : 'Almoxarifado'
  if (m.type === 'receipt') return 'Fornecedor'
  if (m.type === 'return') return m.recipient?.name ?? (m.location ? locationLabel(m.location) : 'Usuário')
  return 'Almoxarifado'
}

function destinationOf(m: Movement): string {
  if (m.kind === 'asset') return m.location ? `${locationLabel(m.location)}${m.recipient ? ` · ${m.recipient.name}` : ''}` : ({ asset_maintenance: 'Manutenção', asset_defective: 'Separado (defeito)', asset_retire: 'Baixa', asset_return: 'Almoxarifado' } as Record<string, string>)[m.type] ?? 'Almoxarifado'
  if (m.type === 'issue') return [m.recipient?.name, m.location && locationLabel(m.location)].filter(Boolean).join(' · ') || 'Entregue'
  if (m.type === 'return') return m.condition === 'defective' ? 'Separado (defeito)' : 'Almoxarifado'
  if (m.type === 'reserve') return 'Reserva'
  if (m.type === 'discard') return 'Descarte'
  return 'Almoxarifado'
}
