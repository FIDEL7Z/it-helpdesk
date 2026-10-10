import { periodLabel } from '../utils/format'
import { useId } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart as RechartsPieChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from './ui/chart'
import type { Count, ManagerDashboard } from '../services/manager'
const COLORS: Record<string, string> = { hardware: 'var(--chart-blue)', software: 'var(--chart-violet)', rede: 'var(--chart-teal)', acesso: 'var(--chart-amber)', outros: 'var(--chart-rose)', alta: 'var(--chart-rose)', media: 'var(--chart-amber)', baixa: 'var(--chart-teal)' }
export function PieChart({ title, rows, label }: { title: string; rows: Count[]; label: (id: string) => string }) {
  const ordered = ['alta', 'media', 'baixa'].map(id => ({ name: label(id), count: rows.find(r => r._id === id)?.count ?? 0, fill: COLORS[id] }))
  const total = ordered.reduce((sum, r) => sum + r.count, 0)
  return <section className="card"><h2 className="card__title">{title}</h2><p className="card__description">Prioridade dos chamados pendentes agora.</p>
    {!total ? <p className="text-muted">Nenhum chamado pendente.</p> : <div className="pie-chart">
      <ChartContainer config={{ count: { label: 'Chamados' } }} aria-label={title}>
        <RechartsPieChart accessibilityLayer><ChartTooltip content={<ChartTooltipContent />} /><Pie data={ordered} dataKey="count" nameKey="name" innerRadius={48} outerRadius={82} isAnimationActive={false} stroke="var(--color-surface)" /></RechartsPieChart>
      </ChartContainer><ul className="chart-legend">{ordered.map(row => <li key={row.name}><span className="chart-swatch" style={{ background: row.fill }} aria-hidden="true" />{row.name}: {row.count} ({new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(row.count / total * 100)}%)</li>)}</ul>
    </div>}
  </section>
}
// Area chart pattern adapted from shadcn/ui: container, configured colors and tooltip.
export function TrendLineChart({ rows }: { rows: ManagerDashboard['trends'] }) {
  const id = useId().replace(/:/g, '')
  if (!rows.length) return null
  return <figure className="line-chart"><figcaption>Evolução de criações e resoluções</figcaption>
    <ChartContainer config={{ created: { label: 'Criados', color: 'var(--chart-blue)' }, resolved: { label: 'Resoluções', color: 'var(--chart-teal)' } }} aria-label="Evolução de criações e resoluções">
      <AreaChart accessibilityLayer data={rows} margin={{ left: 0, right: 12, top: 12 }}>
        <defs>{(['created', 'resolved'] as const).map(key => <linearGradient key={key} id={`${id}-${key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={.35} /><stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={.03} /></linearGradient>)}</defs>
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="period" tickFormatter={periodLabel} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={value => periodLabel(String(value))} />} />
        {(['created', 'resolved'] as const).map(key => <Area key={key} type="linear" dataKey={key} stroke={`var(--color-${key})`} fill={`url(#${id}-${key})`} strokeWidth={2} dot={rows.length === 1} isAnimationActive={false} />)}
      </AreaChart>
    </ChartContainer><ul className="chart-legend chart-legend--inline"><li><span className="chart-swatch" style={{ background: 'var(--chart-blue)' }} />Criados</li><li><span className="chart-swatch" style={{ background: 'var(--chart-teal)' }} />Resoluções</li></ul>
  </figure>
}
export function HorizontalChart({ title, rows, label }: { title: string; rows: Count[]; label: (id: string) => string }) {
  const data = [...rows].sort((a, b) => b.count - a.count || String(a._id).localeCompare(String(b._id))).map(row => ({ name: label(String(row._id)), count: row.count, fill: COLORS[String(row._id)] ?? 'var(--chart-blue)' }))
  return <section className="card"><h2 className="card__title">{title}</h2><p className="card__description">Chamados pendentes, do maior para o menor volume.</p>
    {!data.length ? <p className="text-muted">Nenhum chamado pendente.</p> : <><ChartContainer config={{ count: { label: 'Pendentes' } }} aria-label={title}>
      <BarChart accessibilityLayer data={data} layout="vertical" margin={{ right: 24 }}><CartesianGrid horizontal={false} stroke="var(--color-border)" /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="name" width={80} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="count" radius={4} isAnimationActive={false}>{data.map(row => <Cell key={row.name} fill={row.fill} />)}</Bar></BarChart>
    </ChartContainer><ul className="chart-legend chart-legend--inline">{data.map(row => <li key={row.name}>{row.name}: {row.count}</li>)}</ul></>}
  </section>
}
export function HoursChart({ rows }: { rows: Count[] }) {
  return <section className="card" data-chart="hours" data-observations={rows.length}><h2 className="card__title">Demanda por hora de criação</h2><p className="card__description">Todas as 24 horas, incluindo zero solicitações.</p>
    <ChartContainer config={{ count: { label: 'Solicitações', color: 'var(--chart-blue)' } }} aria-label="Demanda nas 24 horas">
      <BarChart accessibilityLayer data={rows}><CartesianGrid vertical={false} stroke="var(--color-border)" /><XAxis dataKey="_id" tickFormatter={hour => `${hour}h`} interval={3} /><YAxis width={28} allowDecimals={false} /><ChartTooltip content={<ChartTooltipContent labelFormatter={hour => `${hour}h`} />} /><Bar dataKey="count" fill="var(--color-count)" radius={3} isAnimationActive={false} /></BarChart>
    </ChartContainer><details><summary>Consultar quantidades por hora</summary><p>{rows.map(r => `${String(r._id).padStart(2, '0')}h: ${r.count}`).join(' · ')}</p></details>
  </section>
}
