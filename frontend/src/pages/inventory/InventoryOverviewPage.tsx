import { Link, Navigate } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { InventoryNav, MovementList } from '../../components/inventory/InventoryUi'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useResource } from '../../hooks/useResource'
import { listAssets, listMovements, listProducts } from '../../services/inventory'

/** Stock and assets at a glance: what is short, what is out of use, what moved last. */
export function InventoryOverviewPage() {
  const { user } = useAuth()
  return can(user?.role, 'inventory:read') ? <Overview /> : <Navigate to="/dashboard" replace />
}

function Overview() {
  useDocumentTitle('Estoque e patrimônio')
  const { data, error, loading, reload } = useResource(async (signal) => {
    const [products, available, maintenance, movements] = await Promise.all([
      listProducts({ limit: 100 }, signal),
      listAssets({ status: 'available', limit: 1 }, signal),
      listAssets({ status: 'in_maintenance', limit: 5 }, signal),
      listMovements({ limit: 8 }, signal),
    ])
    return { products: products.products, productTotal: products.pagination.total, available: available.pagination.total, maintenance, movements: movements.movements }
  }, [])

  const low = data?.products.filter((p) => p.belowMinimum) ?? []
  const units = data?.products.reduce((sum, p) => sum + (p.stock?.available ?? 0), 0) ?? 0

  return (
    <section className="page inventory-page">
      <header className="page__header page__header--with-action">
        <div>
          <p className="eyebrow">Suporte TI</p>
          <h1 className="page__title">Estoque e patrimônio</h1>
          <p className="page__subtitle">Materiais do almoxarifado, equipamentos identificados e cada movimentação registrada.</p>
        </div>
        <div className="page__actions">
          <Link to="/inventory/products?new=1" className="button button--primary">Novo material</Link>
          <Link to="/inventory/assets?new=1" className="button button--secondary">Cadastrar equipamento</Link>
        </div>
      </header>
      <InventoryNav />

      {error ? (
        <div className="alert alert--error" role="alert"><p>{error}</p><button type="button" className="button button--secondary" onClick={reload}>Tentar novamente</button></div>
      ) : loading && !data ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando estoque...</div>
      ) : data && (
        <>
          <div className="stats inventory-stats">
            <Stat label="Tipos de material ativos" value={data.productTotal} hint="Itens do catálogo, não unidades" />
            <Stat label="Unidades disponíveis" value={units} hint="Materiais por quantidade, fora reservas" />
            <Stat label="Abaixo do mínimo" value={low.length} hint="Precisam de reposição" to="/inventory/products?belowMinimum=true" tone={low.length ? 'attention' : undefined} />
            <Stat label="Equipamentos disponíveis" value={data.available} hint="Patrimônios prontos para entrega" to="/inventory/assets?status=available" />
            <Stat label="Em manutenção" value={data.maintenance.pagination.total} hint="Fora de uso" to="/inventory/assets?status=in_maintenance" />
          </div>

          <div className="inventory-columns">
            <section className="card" aria-labelledby="low-stock">
              <h2 id="low-stock" className="card__title">Abaixo do estoque mínimo</h2>
              {low.length === 0 ? <p className="text-muted">Nenhum material abaixo do mínimo.</p> : (
                <ul className="plain-list">
                  {low.map((p) => (
                    <li key={p.id}>
                      <Link to={`/inventory/products/${p.id}`}>{p.name}</Link>
                      <span className="text-muted"> — {p.stock ? p.stock.available : p.assets?.available ?? 0} disponível(is), mínimo {p.minStock}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card" aria-labelledby="maintenance">
              <h2 id="maintenance" className="card__title">Equipamentos em manutenção</h2>
              {data.maintenance.assets.length === 0 ? <p className="text-muted">Nenhum equipamento em manutenção.</p> : (
                <ul className="plain-list">
                  {data.maintenance.assets.map((a) => <li key={a.id}><Link to={`/inventory/assets/${a.id}`}>{a.assetTag}</Link> <span className="text-muted">— {a.product?.name}</span></li>)}
                </ul>
              )}
            </section>
          </div>

          <section className="card" aria-labelledby="recent-movements">
            <div className="card__header-row">
              <h2 id="recent-movements" className="card__title">Movimentações recentes</h2>
              <Link to="/inventory/movements">Ver todas</Link>
            </div>
            <MovementList movements={data.movements} empty="Nenhuma movimentação registrada ainda." />
          </section>
        </>
      )}
    </section>
  )
}

function Stat({ label, value, hint, to, tone }: { label: string; value: number; hint: string; to?: string; tone?: 'attention' }) {
  const body = <><span className="stat-card__label">{label}</span><span className="stat-card__value">{value}</span><span className="stat-card__hint">{hint}</span></>
  return to
    ? <Link to={to} className={`stat-card stat-card--link${tone ? ` stat-card--${tone}` : ''}`}>{body}</Link>
    : <div className="stat-card">{body}</div>
}
