import { useId } from 'react'
import type { Count, ManagerDashboard } from '../services/manager'

const COLORS = ['var(--chart-blue)', 'var(--chart-teal)', 'var(--chart-amber)', 'var(--chart-violet)', 'var(--chart-rose)']
const SEGMENT_COLORS: Record<string, string> = {
  hardware: COLORS[0], software: COLORS[3], rede: COLORS[1], acesso: COLORS[2], outros: COLORS[4],
  alta: COLORS[4], media: COLORS[2], baixa: COLORS[1],
}
const percentage = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

export function PieChart({ title, rows, label }: { title: string; rows: Count[]; label: (id: string) => string }) {
  const titleId = useId()
  const slices = rows.filter(row => row.count > 0)
  const total = slices.reduce((sum, row) => sum + row.count, 0)
  const arcs = slices.map((row, index) => {
    const start = -Math.PI / 2 + slices.slice(0, index).reduce((sum, previous) => sum + previous.count, 0) / total * Math.PI * 2
    const angle = start + row.count / total * Math.PI * 2
    const point = (a: number) => `${100 + 82 * Math.cos(a)},${100 + 82 * Math.sin(a)}`
    const path = `M100,100 L${point(start)} A82,82 0 ${angle - start > Math.PI ? 1 : 0},1 ${point(angle)} Z`
    return { row, path, color: SEGMENT_COLORS[String(row._id)] ?? COLORS[index % COLORS.length], text: `${label(String(row._id))}: ${row.count} (${percentage.format(row.count / total * 100)}%)` }
  })
  return <section className="card">
    <h2 className="card__title" id={titleId}>{title}</h2>
    <p className="card__description">Participação no backlog atual · {total} chamados pendentes.</p>
    {total === 0 ? <p className="text-muted">Nenhum chamado pendente com os filtros selecionados.</p> : <div className="pie-chart">
      <svg viewBox="0 0 200 200" role="img" aria-labelledby={titleId} className="pie-chart__svg">
        <desc>Distribuição dos chamados pendentes. Quantidades e percentuais disponíveis na legenda.</desc>
        {arcs.map(({ row, path, color, text }) => slices.length === 1
          ? <circle key={String(row._id)} cx="100" cy="100" r="82" fill={color}><title>{text}</title></circle>
          : <path key={String(row._id)} d={path} fill={color} stroke="var(--color-surface)" strokeWidth="2"><title>{text}</title></path>)}
      </svg>
      <ul className="chart-legend">{arcs.map(({ row, color, text }) => <li key={String(row._id)}>
        <span className="chart-swatch" style={{ background: color }} aria-hidden="true" />
        <span>{text}</span>
      </li>)}</ul>
    </div>}
  </section>
}

export function TrendLineChart({ rows }: { rows: ManagerDashboard['trends'] }) {
  const titleId = useId()
  if (rows.length === 0) return null
  const dates = rows.map(row => Date.parse(`${row.period.length === 7 ? `${row.period}-01` : row.period}T00:00:00Z`))
  const min = Math.min(...dates)
  const span = Math.max(...dates) - min
  const step = Math.max(1, Math.ceil(Math.max(...rows.flatMap(row => [row.created, row.resolved])) / 4))
  const max = step * 4
  const x = (index: number) => span === 0 ? 310 : 52 + (dates[index] - min) / span * 516
  const y = (value: number) => 220 - value / max * 180
  const ticks = [...new Set([0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1])]
  const periodLabel = (value: string) => value.length === 7 ? `${value.slice(5)}/${value.slice(0, 4)}` : `${value.slice(8)}/${value.slice(5, 7)}`
  return <figure className="line-chart">
    <figcaption id={titleId}>Evolução de criações e resoluções</figcaption>
    <svg viewBox="0 0 620 270" role="img" aria-labelledby={titleId}>
      <desc>Quantidade por período, com espaçamento proporcional às datas. Azul indica criação e verde indica resoluções comprovadas. A tabela abaixo contém os valores exatos.</desc>
      {[0, 1, 2, 3, 4].map(index => <g key={index}>
        <line x1="52" x2="568" y1={y(index * step)} y2={y(index * step)} className="line-chart__grid" />
        <text x="42" y={y(index * step) + 4} textAnchor="end">{index * step}</text>
      </g>)}
      {ticks.map(index => <text key={index} x={x(index)} y="247" textAnchor="middle">{periodLabel(rows[index].period)}</text>)}
      {(['created', 'resolved'] as const).map(series => <g key={series} className={`line-chart__${series}`}>
        <polyline points={rows.map((row, index) => `${x(index)},${y(row[series])}`).join(' ')} fill="none" strokeWidth="3" strokeLinejoin="round" />
        {rows.map((row, index) => <circle key={row.period} cx={x(index)} cy={y(row[series])} r={series === 'created' ? 5 : 3}>
          <title>{periodLabel(row.period)} · {series === 'created' ? 'Criados' : 'Resoluções'}: {row[series]}</title>
        </circle>)}
      </g>)}
    </svg>
    <ul className="chart-legend chart-legend--inline"><li><span className="chart-swatch" style={{ background: 'var(--chart-blue)' }} aria-hidden="true" />Criados</li><li><span className="chart-swatch" style={{ background: 'var(--chart-teal)' }} aria-hidden="true" />Resoluções</li></ul>
    <p className="field__hint">Pontos representam períodos com registros; linhas conectam esses pontos. Intervalos sem registros não são preenchidos. Um único período aparece como pontos.</p>
  </figure>
}
