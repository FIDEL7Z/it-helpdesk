import { Link } from 'react-router'
import { useResource } from '../../hooks/useResource'
import { getInsights } from '../../services/inventory'

/**
 * Stock and equipment on the management view: what to restock, what is out of use, which
 * materials and departments consumed more and which models break more. Facts, not judgments.
 */
export function InventoryInsights({ period, dataOrigin }: { period: string; dataOrigin: string }) {
  const { data, error } = useResource((signal) => getInsights({ period, dataOrigin }, signal), [period, dataOrigin])
  const insights = data?.insights

  return (
    <section className="manager-section" aria-labelledby="manager-inventory">
      <div className="card__header-row">
        <h2 id="manager-inventory" className="section-title">Estoque e equipamentos</h2>
        <Link to="/inventory">Abrir o módulo completo</Link>
      </div>
      {error ? <p className="alert alert--error" role="alert">{error}</p> : !insights ? <p className="text-muted" role="status">Carregando estoque...</p> : (
        <>
          <dl className="incidents-overview__numbers inventory-insights__numbers">
            <div><dt>Abaixo do mínimo</dt><dd>{insights.stock.belowMinimum.length}</dd></div>
            <div><dt>Equipamentos em manutenção</dt><dd>{insights.assets.in_maintenance ?? 0}</dd></div>
            <div><dt>Equipamentos com defeito</dt><dd>{insights.assets.defective ?? 0}</dd></div>
            <div><dt>Unidades entregues no período</dt><dd>{insights.period.deliveredUnits}</dd></div>
            <div><dt>Movimentações ligadas a chamados</dt><dd>{insights.period.linkedToTickets}</dd></div>
          </dl>
          <div className="manager-related inventory-insights">
            <section className="card" aria-labelledby="inventory-restock">
              <h3 id="inventory-restock" className="card__title">Para repor</h3>
              {insights.stock.belowMinimum.length === 0 ? <p className="text-muted">Nenhum material abaixo do mínimo.</p> : (
                <ul className="plain-list">
                  {insights.stock.belowMinimum.map((p) => <li key={p.id}><Link to={`/inventory/products/${p.id}`}>{p.name}</Link><span className="text-muted">— {p.available} disponível(is), mínimo {p.minStock}</span></li>)}
                </ul>
              )}
            </section>
            <Ranking id="inventory-top" title="Materiais mais entregues" rows={insights.period.topProducts} empty="Nenhuma entrega no período." link={(id) => `/inventory/products/${id}`} />
            <Ranking id="inventory-departments" title="Entregas por departamento" rows={insights.period.byDepartment} empty="Nenhuma entrega com departamento informado." link={(id) => `/inventory/movements?departmentId=${id}`} />
            <Ranking id="inventory-defects" title="Defeitos registrados por modelo" rows={insights.period.defectsByProduct} empty="Nenhum defeito registrado no período." link={(id) => `/inventory/products/${id}`} />
          </div>
          <p className="field__hint">Consumo maior não significa desperdício: depende do tamanho e da atividade de cada setor. Entregas estornadas não contam; o saldo do almoxarifado é físico e não depende da origem dos dados.</p>
        </>
      )}
    </section>
  )
}

function Ranking({ id, title, rows, empty, link }: { id: string; title: string; rows: { id: string; name: string; units: number }[]; empty: string; link: (id: string) => string }) {
  return (
    <section className="card" aria-labelledby={id}>
      <h3 id={id} className="card__title">{title}</h3>
      {rows.length === 0 ? <p className="text-muted">{empty}</p> : (
        <ol className="plain-list">
          {rows.map((row) => <li key={row.id}><Link to={link(row.id)}>{row.name}</Link><span className="text-muted">— {row.units} un.</span></li>)}
        </ol>
      )}
    </section>
  )
}
