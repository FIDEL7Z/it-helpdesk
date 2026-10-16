import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { AssetStatusBadge, FormMessage, InventoryNav, LocationFields, PersonSelect } from '../../components/inventory/InventoryUi'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useOperationKey } from '../../hooks/useOperationKey'
import { useResource } from '../../hooks/useResource'
import { ASSET_STATUS_LABELS, inventoryErrorMessage, listAssets, listProducts, registerAsset, type AssetStatus } from '../../services/inventory'
import { getOrganization, listPeople, locationLabel, type Department, type Person } from '../../services/organization'
import { getErrorMessage } from '../../utils/errors'

/** Equipment by asset tag: where it is, with whom, in which state; history one click away. */
export function AssetsPage() {
  const { user } = useAuth()
  return can(user?.role, 'inventory:read') ? <Assets canEdit={can(user?.role, 'inventory:operate')} /> : <Navigate to="/dashboard" replace />
}

function Assets({ canEdit }: { canEdit: boolean }) {
  useDocumentTitle('Equipamentos')
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const departmentId = params.get('departmentId') ?? ''
  const q = params.get('q') ?? ''
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [creating, setCreating] = useState(params.get('new') === '1')
  const [search, setSearch] = useState(q)
  const list = useResource((signal) => listAssets({ status, departmentId, q, page, limit: 20 }, signal), [status, departmentId, q, page])
  const support = useResource(async (signal) => {
    const [org, people] = await Promise.all([getOrganization(signal), canEdit ? listPeople(signal) : Promise.resolve({ people: [] as Person[] })])
    return { departments: org.departments, people: people.people }
  }, [canEdit])

  function update(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    next.delete('page')
    next.delete('new')
    setParams(next)
  }

  return (
    <section className="page inventory-page">
      <header className="page__header page__header--with-action">
        <div>
          <h1 className="page__title">Equipamentos</h1>
          <p className="page__subtitle">Cada equipamento identificado pelo número de patrimônio.</p>
        </div>
        {canEdit && !creating && <button type="button" className="button button--primary" onClick={() => setCreating(true)}>Cadastrar equipamento</button>}
      </header>
      <InventoryNav />

      {creating && support.data && (
        <RegisterAssetForm departments={support.data.departments} people={support.data.people} initialProductId={params.get('productId') ?? ''} onCancel={() => setCreating(false)} />
      )}

      <div className="queue-panel">
        <form className="toolbar__search" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); update('q', search.trim()) }}>
          <label htmlFor="asset-search" className="sr-only">Pesquisar por patrimônio, série ou responsável</label>
          <input id="asset-search" className="field__input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Patrimônio, número de série ou responsável" maxLength={60} />
          <button type="submit" className="button button--secondary">Buscar</button>
        </form>
        <div className="toolbar__filters">
          <div className="filter">
            <label htmlFor="asset-status-filter" className="filter__label">Situação</label>
            <select id="asset-status-filter" className="field__input field__select" value={status} onChange={(e) => update('status', e.target.value)}>
              <option value="">Todas</option>
              {(Object.keys(ASSET_STATUS_LABELS) as AssetStatus[]).map((s) => <option key={s} value={s}>{ASSET_STATUS_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="filter">
            <label htmlFor="asset-department-filter" className="filter__label">Departamento</label>
            <select id="asset-department-filter" className="field__input field__select" value={departmentId} onChange={(e) => update('departmentId', e.target.value)}>
              <option value="">Todos</option>
              {support.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {list.error ? (
        <div className="alert alert--error" role="alert"><p>{list.error}</p><button type="button" className="button button--secondary" onClick={list.reload}>Tentar novamente</button></div>
      ) : list.loading && !list.data ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando equipamentos...</div>
      ) : list.data && list.data.assets.length === 0 ? (
        <div className="card card--empty"><p>Nenhum equipamento encontrado com esses filtros.</p></div>
      ) : list.data && (
        <div className={`card card--table${list.loading ? ' is-loading' : ''}`} aria-busy={list.loading}>
          <table className="ticket-table inventory-table">
            <caption className="sr-only">Equipamentos patrimoniados</caption>
            <thead><tr><th scope="col">Patrimônio</th><th scope="col">Equipamento</th><th scope="col">Responsável</th><th scope="col">Local</th><th scope="col">Situação</th></tr></thead>
            <tbody>
              {list.data.assets.map((a) => (
                <tr key={a.id}>
                  <td data-label="Patrimônio" className="ticket-table__title"><Link to={`/inventory/assets/${a.id}`}>{a.assetTag}</Link>{a.serialNumber && <span className="table-sub">Série {a.serialNumber}</span>}</td>
                  <td data-label="Equipamento">{a.product?.name ?? '—'}</td>
                  <td data-label="Responsável" className={a.holder ? undefined : 'text-muted'}>{a.holder?.name ?? '—'}</td>
                  <td data-label="Local">{locationLabel(a.location)}</td>
                  <td data-label="Situação"><AssetStatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.pagination.totalPages > 1 && (
        <nav className="pagination" aria-label="Paginação dos equipamentos">
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

function RegisterAssetForm({ departments, people, initialProductId, onCancel }: { departments: Department[]; people: Person[]; initialProductId: string; onCancel: () => void }) {
  const navigate = useNavigate()
  const models = useResource((signal) => listProducts({ tracking: 'asset', limit: 100 }, signal), [])
  const [productId, setProductId] = useState(initialProductId)
  const [assetTag, setAssetTag] = useState('')
  const [serialNumber, setSerialNumber] = useState('')
  const [inUse, setInUse] = useState(false)
  const [holderId, setHolderId] = useState('')
  const [place, setPlace] = useState({ departmentId: '', roomId: '' })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const key = useOperationKey()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!productId) { setMessage({ type: 'error', text: 'Escolha o modelo do equipamento.' }); return }
    if (assetTag.trim().length < 2) { setMessage({ type: 'error', text: 'Informe o número de patrimônio.' }); return }
    if (inUse && !place.departmentId) { setMessage({ type: 'error', text: 'Um equipamento em uso precisa de um departamento.' }); return }
    setSaving(true)
    setMessage(null)
    try {
      const result = await registerAsset({
        operationId: key.key, productId, assetTag: assetTag.trim(), serialNumber: serialNumber.trim() || null,
        status: inUse ? 'in_use' : 'available', ...(inUse && { departmentId: place.departmentId, roomId: place.roomId || null, holderId: holderId || null }),
      })
      key.renew()
      navigate(`/inventory/assets/${result.asset.id}`)
    } catch (caught) {
      setMessage({ type: 'error', text: inventoryErrorMessage(caught, getErrorMessage(caught)) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="form card" onSubmit={submit} noValidate aria-labelledby="asset-form-title">
      <h2 id="asset-form-title" className="card__title">Cadastrar equipamento</h2>
      <div className="form__row">
        <div className="field">
          <label htmlFor="asset-product" className="field__label">Modelo</label>
          <select id="asset-product" className="field__input field__select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Selecione</option>
            {models.data?.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <p className="field__hint">Só materiais controlados por patrimônio. <Link to="/inventory/products?new=1">Cadastrar modelo</Link></p>
        </div>
        <div className="field">
          <label htmlFor="asset-tag" className="field__label">Número de patrimônio</label>
          <input id="asset-tag" className="field__input" value={assetTag} maxLength={40} onChange={(e) => setAssetTag(e.target.value)} placeholder="Ex.: PAT-0101" />
        </div>
        <div className="field">
          <label htmlFor="asset-serial" className="field__label">Número de série (opcional)</label>
          <input id="asset-serial" className="field__input" value={serialNumber} maxLength={80} onChange={(e) => setSerialNumber(e.target.value)} />
        </div>
      </div>
      <label className="checkbox" htmlFor="asset-in-use"><input id="asset-in-use" type="checkbox" checked={inUse} onChange={(e) => setInUse(e.target.checked)} /> Já está em uso em algum setor</label>
      {inUse && (
        <>
          <PersonSelect id="asset-register-holder" people={people} value={holderId} onChange={setHolderId} label="Responsável" />
          <LocationFields idPrefix="asset-register-place" departments={departments} value={place} onChange={setPlace} legend="Onde está" required />
        </>
      )}
      <FormMessage message={message} />
      <div className="form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>{saving ? 'Cadastrando...' : 'Cadastrar equipamento'}</button>
        <button type="button" className="button button--ghost" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  )
}
