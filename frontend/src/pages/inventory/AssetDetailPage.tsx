import { Link, Navigate, useParams } from 'react-router'
import { can } from '../../auth/permissions'
import { useAuth } from '../../auth/useAuth'
import { AssetActionForm } from '../../components/inventory/AssetActionForm'
import { AssetStatusBadge, InventoryNav, MovementList } from '../../components/inventory/InventoryUi'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useResource } from '../../hooks/useResource'
import { getAsset } from '../../services/inventory'
import { getOrganization, listPeople, locationLabel } from '../../services/organization'
import { formatDateTime } from '../../utils/format'

export function AssetDetailPage() {
  const { user } = useAuth()
  return can(user?.role, 'inventory:read') ? <AssetDetail /> : <Navigate to="/dashboard" replace />
}

function AssetDetail() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const canOperate = can(user?.role, 'inventory:operate')
  const detail = useResource((signal) => getAsset(id, signal), [id])
  const support = useResource(async (signal) => {
    const [org, people] = await Promise.all([getOrganization(signal), listPeople(signal)])
    return { departments: org.departments, people: people.people }
  }, [])
  const asset = detail.data?.asset
  useDocumentTitle(asset ? `Patrimônio ${asset.assetTag}` : 'Equipamento')

  if (detail.error) return <section className="page"><InventoryNav /><div className="alert alert--error" role="alert"><p>{detail.error}</p></div></section>
  if (!asset) return <section className="page"><div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando equipamento...</div></section>

  return (
    <section className="page inventory-page">
      <Link to="/inventory/assets" className="back-link">← Voltar aos equipamentos</Link>
      <header className="page__header">
        <p className="eyebrow">Patrimônio</p>
        <h1 className="page__title">{asset.assetTag} <AssetStatusBadge status={asset.status} /></h1>
        <p className="page__subtitle">{asset.product ? <Link to={`/inventory/products/${asset.product.id}`}>{asset.product.name}</Link> : 'Modelo indisponível'}{asset.serialNumber && ` · Série ${asset.serialNumber}`}</p>
      </header>
      <InventoryNav />

      <div className="inventory-columns">
        <section className="card" aria-labelledby="asset-now">
          <h2 id="asset-now" className="card__title">Situação atual</h2>
          <dl className="details details--compact">
            <div className="details__row"><dt>Local</dt><dd>{locationLabel(asset.location)}</dd></div>
            <div className="details__row"><dt>Responsável</dt><dd>{asset.holder?.name ?? '—'}</dd></div>
            {asset.ticket && <div className="details__row"><dt>Reservado para</dt><dd><Link to={`/tickets/${asset.ticket.id}`}>{asset.ticket.title}</Link></dd></div>}
            <div className="details__row"><dt>Atualizado</dt><dd>{formatDateTime(asset.updatedAt)}</dd></div>
          </dl>
        </section>
        {canOperate && support.data && (
          <section className="card" aria-labelledby="asset-actions">
            <h2 id="asset-actions" className="card__title">Registrar ação</h2>
            <AssetActionForm key={`${asset.id}-${asset.version}`} asset={asset} departments={support.data.departments} people={support.data.people}
              canRetire={can(user?.role, 'inventory:adjust')} onDone={() => detail.reload()} />
          </section>
        )}
      </div>

      <section className="card" aria-labelledby="asset-history">
        <h2 id="asset-history" className="card__title">Histórico do equipamento</h2>
        <MovementList movements={detail.data?.history ?? []} showProduct={false} empty="Sem movimentações." />
      </section>
    </section>
  )
}
