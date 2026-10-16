import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { InventoryNav } from '../../components/inventory/InventoryUi'
import { ProductForm } from '../../components/inventory/ProductForm'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useResource } from '../../hooks/useResource'
import { getProductTypes, listProducts, TRACKING_LABELS, type Product, type ProductType } from '../../services/inventory'

/** Catalog: search by name, brand or model, filter by type, see what is available and what is short. */
export function ProductsPage() {
  const { user } = useAuth()
  return can(user?.role, 'inventory:read') ? <Products canEdit={can(user?.role, 'inventory:operate')} /> : <Navigate to="/dashboard" replace />
}

function Products({ canEdit }: { canEdit: boolean }) {
  useDocumentTitle('Materiais')
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const type = params.get('type') ?? ''
  const belowMinimum = params.get('belowMinimum') === 'true'
  const status = params.get('status') ?? 'active'
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [creating, setCreating] = useState(params.get('new') === '1')
  const [search, setSearch] = useState(q)

  const catalog = useResource((signal) => getProductTypes(signal), [])
  const list = useResource((signal) => listProducts({ q, type, status, belowMinimum: belowMinimum || undefined, page, limit: 20 }, signal), [q, type, status, belowMinimum, page])

  function update(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    next.delete('page')
    next.delete('new')
    setParams(next)
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    update('q', search.trim())
  }

  const types = catalog.data?.types

  return (
    <section className="page inventory-page">
      <header className="page__header page__header--with-action">
        <div>
          <h1 className="page__title">Materiais</h1>
          <p className="page__subtitle">Catálogo do almoxarifado com saldo, mínimo e características.</p>
        </div>
        {canEdit && !creating && <button type="button" className="button button--primary" onClick={() => setCreating(true)}>Novo material</button>}
      </header>
      <InventoryNav />

      {creating && types && (
        <ProductForm catalog={types} onCancel={() => setCreating(false)} onSaved={(product: Product) => navigate(`/inventory/products/${product.id}`, { state: { created: true } })} />
      )}

      <div className="queue-panel">
        <form className="toolbar__search" role="search" onSubmit={submitSearch}>
          <label htmlFor="product-search" className="sr-only">Pesquisar por nome, marca ou modelo</label>
          <input id="product-search" className="field__input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome, marca, modelo ou SKU" maxLength={100} />
          <button type="submit" className="button button--secondary">Buscar</button>
        </form>
        <div className="toolbar__filters">
          <div className="filter">
            <label htmlFor="product-type-filter" className="filter__label">Tipo</label>
            <select id="product-type-filter" className="field__input field__select" value={type} onChange={(e) => update('type', e.target.value)}>
              <option value="">Todos</option>
              {types && (Object.keys(types) as ProductType[]).map((key) => <option key={key} value={key}>{types[key].label}</option>)}
            </select>
          </div>
          <div className="filter">
            <label htmlFor="product-status-filter" className="filter__label">Situação</label>
            <select id="product-status-filter" className="field__input field__select" value={status} onChange={(e) => update('status', e.target.value === 'active' ? '' : e.target.value)}>
              <option value="active">Ativos</option><option value="inactive">Inativos</option><option value="all">Todos</option>
            </select>
          </div>
          <label className="checkbox filter__check" htmlFor="product-low">
            <input id="product-low" type="checkbox" checked={belowMinimum} onChange={(e) => update('belowMinimum', e.target.checked ? 'true' : '')} /> Só abaixo do mínimo
          </label>
        </div>
      </div>

      {list.error ? (
        <div className="alert alert--error" role="alert"><p>{list.error}</p><button type="button" className="button button--secondary" onClick={list.reload}>Tentar novamente</button></div>
      ) : list.loading && !list.data ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando materiais...</div>
      ) : list.data && list.data.products.length === 0 ? (
        <div className="card card--empty"><p>Nenhum material encontrado com esses filtros.</p></div>
      ) : list.data && (
        <div className={`card card--table${list.loading ? ' is-loading' : ''}`} aria-busy={list.loading}>
          <table className="ticket-table inventory-table">
            <caption className="sr-only">Materiais do catálogo</caption>
            <thead><tr><th scope="col">Material</th><th scope="col">Tipo</th><th scope="col">Controle</th><th scope="col">Disponível</th><th scope="col">Reservado</th><th scope="col">Mínimo</th></tr></thead>
            <tbody>
              {list.data.products.map((p) => (
                <tr key={p.id}>
                  <td data-label="Material" className="ticket-table__title">
                    <Link to={`/inventory/products/${p.id}`}>{p.name}</Link>
                    <span className="table-sub">{[p.brand, p.model, p.sku].filter(Boolean).join(' · ')}</span>
                    {p.belowMinimum && <span className="attention-tag">Abaixo do mínimo</span>}
                    {!p.active && <span className="origin-tag">Inativo</span>}
                  </td>
                  <td data-label="Tipo">{types?.[p.type].label ?? p.type}</td>
                  <td data-label="Controle">{TRACKING_LABELS[p.tracking]}</td>
                  <td data-label="Disponível"><strong>{p.stock ? p.stock.available : p.assets?.available ?? 0}</strong></td>
                  <td data-label="Reservado">{p.stock ? p.stock.reserved : p.assets?.reserved ?? 0}</td>
                  <td data-label="Mínimo">{p.minStock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.data && list.data.pagination.totalPages > 1 && (
        <nav className="pagination" aria-label="Paginação dos materiais">
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
