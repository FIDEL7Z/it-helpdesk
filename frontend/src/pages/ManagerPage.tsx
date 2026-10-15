import { periodLabel } from '../utils/format'
import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { DEMO_MODE } from '../config/demo'
import { PieChart, TrendLineChart, HorizontalChart, HoursChart } from '../components/ManagerCharts'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { getManagerDashboard, type ManagerDashboard, type Count } from '../services/manager'
import { CATEGORY_LABELS, PRIORITY_LABELS, STATUS_LABELS, SUBJECT_LABELS } from '../services/tickets'
import { IncidentsOverview } from '../components/IncidentsOverview'
import { QualityOverview } from '../components/QualityOverview'
import { getErrorMessage } from '../utils/errors'

const PERIODS = { today: 'Hoje', week: 'Últimos sete dias', month: 'Mês atual', year: 'Ano atual' }
const ORIGINS = { operational: 'Operacionais', demo: 'Demonstração — dados fictícios', legacy: 'Legado — origem não comprovada' }
const WEEKDAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo']

export function ManagerPage() {
  const { user } = useAuth()
  return user?.role === 'gestor' ? <ManagerContent /> : <Navigate to="/dashboard" replace />
}

const isEmpty = (data: ManagerDashboard) => data.current.total === 0 && data.period.created === 0 && data.period.resolutions === 0

/**
 * Management view, ordered by the decisions it supports: current situation, what needs
 * attention, the team, incidents, service quality and, last, demand and trends.
 */
function ManagerContent() {
  useDocumentTitle('Visão gerencial')
  const [params, setParams] = useSearchParams()
  const key = params.toString()
  const [retry, setRetry] = useState(0)
  const requestKey = `${key}#${retry}`
  const [state, setState] = useState<{ key: string; data: ManagerDashboard | null; error: string | null }>({ key: '', data: null, error: null })
  // Set when the demo environment opened on the demo data because there is no operational data.
  const [originNote, setOriginNote] = useState<string | null>(null)
  // Keyed results prevent stale totals from being displayed under newly selected filters.
  const loading = state.key !== requestKey
  const data = loading ? null : state.data
  const error = loading ? null : state.error
  useEffect(() => {
    const controller = new AbortController()
    const query = DEMO_MODE ? new URLSearchParams(key) : new URLSearchParams([...new URLSearchParams(key)].filter(([name]) => name !== 'dataOrigin'))
    getManagerDashboard(query, controller.signal)
      .then(async ({ dashboard }) => {
        // Demo environment without operational data: open on the demo data once, saying so,
        // instead of a page of zeros. The data stays separated and labelled as fictitious.
        if (DEMO_MODE && dashboard.demoControlsEnabled && !query.has('dataOrigin') && isEmpty(dashboard)) {
          const demoQuery = new URLSearchParams(query)
          demoQuery.set('dataOrigin', 'demo')
          const demo = await getManagerDashboard(demoQuery, controller.signal)
          if (!isEmpty(demo.dashboard)) {
            setOriginNote('Ainda não há chamados operacionais. Você está vendo os dados de demonstração, que são fictícios e ficam separados.')
            setParams(demoQuery, { replace: true })
            return
          }
        }
        setState({ key: requestKey, data: dashboard, error: null })
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ key: requestKey, data: null, error: getErrorMessage(error) }) })
    return () => controller.abort()
  }, [key, requestKey, setParams])
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    if (name === 'dataOrigin') setOriginNote(null)
    setParams(next)
  }
  const origin = DEMO_MODE ? params.get('dataOrigin') ?? 'operational' : 'operational'
  const options = state.data?.options
  // Historical actor selection becomes current assignee selection only when opening an operational queue.
  function tickets(extra: Record<string, string> = {}) {
    const query = new URLSearchParams({ dataOrigin: origin })
    for (const name of ['category', 'priority', 'status', 'requesterId']) { const value = params.get(name); if (value) query.set(name, value) }
    const analyst = params.get('analystId')
    if (analyst) query.set('assigneeId', analyst)
    for (const [name, value] of Object.entries(extra)) query.set(name, value)
    if (extra.assignee) query.delete('assigneeId')
    return `/tickets?${query}`
  }
  const highestLoad = data ? Math.max(0, ...data.team.map(row => row.pending)) : 0
  const busiest = data ? data.team.filter(row => row.pending > 0 && row.pending === highestLoad) : []
  const operators = data ? data.team.filter(row => row.active && (row.role === 'ti' || row.role === 'gestor')) : []
  const averageLoad = operators.length ? operators.reduce((sum, row) => sum + row.pending, 0) / operators.length : 0
  return <section className="page manager-page">
    <header className="page__header page__header--with-action">
      <div><p className="eyebrow">Gestão de TI</p><h1 className="page__title">Visão gerencial</h1><p className="page__subtitle">Onde agir agora, como está a equipe e como os solicitantes avaliam as resoluções.</p></div>
      <div className="page__actions"><button className="button button--secondary" onClick={() => setRetry(n => n + 1)}>Atualizar indicadores</button></div>
    </header>

    {/* Period and origin stay visible; the rest of the filters are one click away. */}
    <div className="card manager-filters manager-filterbar" aria-label="Filtros gerenciais">
      <div className="manager-filterbar__main">
        <Select name="period" label="Período" value={params.get('period') ?? 'month'} options={Object.entries(PERIODS)} onChange={filter} />
        {DEMO_MODE && state.data?.demoControlsEnabled && <Select name="dataOrigin" label="Origem dos dados" value={origin} options={Object.entries(ORIGINS)} onChange={filter} />}
        {data && <p className={`manager-source${origin === 'demo' ? ' manager-source--demo' : ''}${origin === 'legacy' ? ' manager-source--legacy' : ''}`}>
          {origin !== 'operational' ? `${ORIGINS[origin as keyof typeof ORIGINS]} · ` : 'Dados operacionais · '}{new Intl.DateTimeFormat('pt-BR', { timeZone: data.range.timezone, dateStyle: 'short' }).format(new Date(data.range.start))} até {new Intl.DateTimeFormat('pt-BR', { timeZone: data.range.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.asOf))}
        </p>}
      </div>
      <details className="manager-filters__advanced"><summary>Mais filtros: equipe, solicitante e classificação</summary><div className="manager-filters__grid">
      <Select name="analystId" label="Analista / gestor operador" value={params.get('analystId') ?? ''} options={[['', 'Toda a equipe'], ...(options?.analysts.map(u => [u.id, u.name] as [string, string]) ?? [])]} onChange={filter} />
      <Select name="requesterId" label="Solicitante" value={params.get('requesterId') ?? ''} options={[['', 'Todos'], ...(options?.requesters.map(u => [u.id, u.name] as [string, string]) ?? [])]} onChange={filter} />
      <Select name="category" label="Categoria atual" value={params.get('category') ?? ''} options={[['', 'Todas'], ...Object.entries(CATEGORY_LABELS)]} onChange={filter} />
      <Select name="priority" label="Prioridade atual" value={params.get('priority') ?? ''} options={[['', 'Todas'], ...Object.entries(PRIORITY_LABELS)]} onChange={filter} />
      <Select name="status" label="Status atual" value={params.get('status') ?? ''} options={[['', 'Todos'], ...Object.entries(STATUS_LABELS)]} onChange={filter} />
      <div className="field"><label htmlFor="manager-ageDays" className="field__label">Idade mínima (dias)</label><input id="manager-ageDays" className="field__input" type="number" min="1" max="365" value={params.get('ageDays') ?? 7} onChange={e => filter('ageDays', e.target.value)} /></div>
      <div className="field"><label htmlFor="manager-inactivityDays" className="field__label">Sem movimentação (dias)</label><input id="manager-inactivityDays" className="field__input" type="number" min="1" max="90" value={params.get('inactivityDays') ?? 3} onChange={e => filter('inactivityDays', e.target.value)} /></div>
      <button className="button button--secondary" onClick={() => setParams(new URLSearchParams())}>Limpar filtros</button>
      </div><p className="field__hint">Analista filtra o responsável na carga atual e nas solicitações; nos eventos, filtra o autor da ação. Categoria, prioridade e status refletem o estado atual do chamado.</p></details>
    </div>

    {originNote && <p className="alert alert--info" role="status">{originNote}</p>}

    {loading ? <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando visão gerencial...</div>
      : error ? <div className="alert alert--error" role="alert"><p>{error}</p><button className="button button--secondary" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></div>
      : data && <div className="dashboard manager-sections">
        {isEmpty(data) && <p className="alert alert--info" role="status">Não há chamados nesta origem de dados com os filtros atuais. Os zeros abaixo indicam ausência de registros, não desempenho da equipe.</p>}

        <section aria-labelledby="manager-current" className="manager-section">
          <h2 id="manager-current" className="section-title">Situação atual</h2>
          <div className="manager-stats">
            <Metric label="Backlog atual" value={data.current.backlog} to={tickets({ pending: 'true' })} hint="Abertos + em andamento; qualquer data de criação" />
            <Metric label="Pendentes sem responsável" value={data.current.unassigned} to={tickets({ assignee: 'none', pending: 'true' })} hint="Chamados abertos ou em andamento" />
            <Metric label="Em andamento agora" value={data.current.inProgress} to={tickets({ status: 'em_andamento' })} hint="Situação atual, sem filtro de criação" />
            <Metric label="Criados no período" to={tickets({ createdFrom: data.range.start, createdTo: data.range.end })} value={data.period.created} hint="Aberturas, independentemente do status atual" />
            <Metric label="Resoluções no período" value={data.period.resolutions} hint={`${data.period.resolvedTickets} chamados distintos · uma resolução por ciclo`} />
            <Metric label="Reaberturas no período" value={data.period.reopenings} hint="Pela equipe; contestações do solicitante ficam em Qualidade" />
          </div>
        </section>

        <section aria-labelledby="manager-alerts" className="manager-section"><h2 id="manager-alerts" className="section-title">Precisa de atenção</h2><div className="manager-alerts">
          <Link className="alert-card" to={tickets({ attention: 'high_unassigned', pending: 'true' })}><strong className="alert-card__value">{data.alerts.highUnassigned}</strong><span>Alta prioridade sem responsável</span><span>Consultar fila →</span></Link>
          <Link className="alert-card" to={tickets({ attention: 'oldest', ageDays: String(data.alerts.ageDays), pending: 'true' })}><strong className="alert-card__value">{data.alerts.oldPending}</strong><span>Pendentes há {data.alerts.ageDays} dias ou mais</span><span>Consultar mais antigos →</span></Link>
          <Link className="alert-card" to={tickets({ attention: 'inactive', inactivityDays: String(data.alerts.inactivityDays), pending: 'true' })}><strong className="alert-card__value">{data.alerts.inactive}</strong><span>Sem movimentação há {data.alerts.inactivityDays} dias</span><span>Consultar fila →</span></Link>
        </div>
        {busiest.length > 0 && operators.length > 1 && highestLoad > averageLoad && <p className="manager-load-note">
          <strong>Carga desigual:</strong> {busiest.map(row => row.name).join(' e ')} {busiest.length > 1 ? 'estão' : 'está'} com {highestLoad} pendências; a média da equipe é {averageLoad.toFixed(1).replace('.', ',')}. Avalie redistribuir — é um dado de carga atual, não de desempenho. <Link to={tickets(busiest.length === 1 ? { assigneeId: busiest[0].id, pending: 'true' } : { pending: 'true' })}>Ver fila</Link>
        </p>}
        <details className="manager-help"><summary>Como interpretar os alertas</summary><p>Idade: tempo desde a abertura. Inatividade: desde a última ação comprovada de suporte ou gestor. {data.alerts.unknownActivity} pendências sem movimentação comprovada não entram no alerta de inatividade. Não representam SLA. Ajuste os dias em “Mais filtros”.</p></details>
        {data.alerts.oldest.length > 0 && <details className="manager-help"><summary>Pendências mais antigas</summary><ul>{data.alerts.oldest.map(row => <li key={row.id}><Link to={`/tickets/${row.id}`} state={{ returnTo: tickets({ pending: 'true' }) }}>{row.title}</Link> · {row.ageDays} dias desde a abertura</li>)}</ul></details>}
        </section>

        <section aria-labelledby="manager-team-title" className="manager-section">
          <h2 id="manager-team-title" className="section-title">Equipe</h2>
          <div className="manager-related">
          <section className="card" aria-labelledby="manager-team">
            <h3 id="manager-team" className="card__title">Equipe de suporte</h3>
            <p className="card__description">Ordenada por pendências atuais. Inclui TI e gestores operadores, mesmo sem chamados. Resoluções contam o autor comprovado, não o responsável atual. Volume e carga não medem qualidade.</p>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Indicadores da equipe, role horizontalmente quando necessário"><table className="manager-table">
              <caption className="sr-only">Carga atual e ações comprovadas por autor no período</caption><thead><tr><th>Analista</th><th>Carga atual</th><th>Em andamento</th><th>Alta prioridade</th><th>Resoluções no período</th><th>Fila</th></tr></thead>
              <tbody>{data.team.map(row => <tr key={row.id}><th scope="row">{row.name}<small>{row.role === 'gestor' ? 'Gestor operador' : row.role === 'ti' ? 'Suporte TI' : 'Participação histórica'}{!row.active ? ' · Inativo / indisponível' : ''}</small>{row.pending > 0 && row.pending === highestLoad && <small className="load-highlight">Maior carga atual</small>}</th><td>{row.pending}</td><td>{row.inProgress}</td><td><Link to={tickets({ assigneeId: row.id, priority: 'alta', pending: 'true' })}>{row.highPriority}</Link></td><td>{row.resolutions}</td><td><Link to={tickets({ assigneeId: row.id })}>Ver chamados</Link></td></tr>)}</tbody>
            </table></div>
            {data.team.length === 0 && <p className="text-muted">Nenhum operador corresponde ao filtro.</p>}
            <details className="manager-help"><summary>Entenda os indicadores de equipe</summary><p>Atribuídos: todos os status. Pendentes: abertos + em andamento. Participação: chamados distintos com ação do autor no período. Reaberturas: executadas pelo próprio autor; não atribuem culpa ao responsável ou ao resolvedor anterior.</p></details>
            <Link to={tickets({ assignee: 'none' })}>Consultar chamados sem responsável</Link>
          </section>
          <section className="card"><h3 className="card__title">Carga por responsável e prioridade</h3><p className="card__description">Pendências atuais; inclui a fila sem responsável.</p><ul className="workload-list">{data.workload.map(row => <li key={row.id ?? 'none'}><Link to={tickets(row.id ? { assigneeId: row.id, pending: 'true' } : { assignee: 'none', pending: 'true' })}>{row.name} · {row.pending}</Link><div className="workload-bars" aria-hidden="true">{(['alta', 'media', 'baixa'] as const).map(priority => <span key={priority} className={`workload-bars__${priority}`} style={{ width: `${row[priority] / Math.max(1, ...data.workload.map(r => r.pending)) * 100}%` }} />)}</div><small>Alta {row.alta} · Média {row.media} · Baixa {row.baixa}</small></li>)}</ul></section>
          </div>
        </section>

        <IncidentsOverview dataOrigin={origin} />
        <QualityOverview quality={data.quality} />

        <section aria-labelledby="manager-demand" className="manager-section">
          <h2 id="manager-demand" className="section-title">Demanda e tendências</h2>
          <div className="dashboard__grid">
            <Distribution title="Assuntos mais solicitados no período" rows={data.demand.categories} label={id => SUBJECT_LABELS[id as keyof typeof SUBJECT_LABELS] ?? id} />
            <section className="card" aria-labelledby="manager-requesters">
              <h3 id="manager-requesters" className="card__title">Solicitantes no período</h3><p className="card__description">Até dez maiores volumes de criação. Pendências pertencem aos chamados criados no período; qualquer perfil pode ser solicitante.</p>
              {data.requesters.length === 0 ? <p className="text-muted">Nenhuma solicitação criada neste período com os filtros selecionados.</p> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Ranking de solicitantes"><table className="manager-table"><thead><tr><th>Solicitante</th><th>Solicitações</th><th>Ainda pendentes</th><th>Categorias mais solicitadas</th></tr></thead><tbody>{data.requesters.map(row => <tr key={row.id}><th scope="row"><Link to={tickets({ requesterId: row.id, createdFrom: data.range.start, createdTo: data.range.end })}>{row.name}</Link></th><td>{row.created}</td><td>{row.pending}</td><td>{row.categories.slice(0, 3).map(c => `${CATEGORY_LABELS[c.category as keyof typeof CATEGORY_LABELS] ?? c.category} (${c.count})`).join(', ')}</td></tr>)}</tbody></table></div>}
            </section>
          </div>
          <section className="card" aria-labelledby="manager-trends"><h3 id="manager-trends" className="card__title">Tendências e horários</h3><p className="card__description">Criações e resoluções no período selecionado.</p>
            <TrendLineChart rows={data.trends} />
            {data.trends.length === 0 ? <p className="text-muted">Sem criações ou resoluções comprovadas no período.</p> : <details><summary>Consultar valores por período</summary><div className="table-scroll" tabIndex={0} role="region" aria-label="Evolução de chamados"><table className="manager-table manager-table--trends"><thead><tr><th>Período</th><th>Criados</th><th>Resoluções</th><th>Evolução</th></tr></thead><tbody>{data.trends.map(row => <tr key={row.period}><th scope="row">{periodLabel(row.period)}</th><td>{row.created}</td><td>{row.resolved}</td><td><div className="trend-bars" aria-hidden="true"><span className="trend-bars__created" style={{ width: `${row.created / Math.max(1, ...data.trends.map(r => Math.max(r.created, r.resolved))) * 100}%` }} /><span className="trend-bars__resolved" style={{ width: `${row.resolved / Math.max(1, ...data.trends.map(r => Math.max(r.created, r.resolved))) * 100}%` }} /></div></td></tr>)}</tbody></table></div></details>}
          </section>
          <div className="dashboard__grid">
            <PieChart title="Backlog por prioridade" rows={data.distributions.priority} label={id => PRIORITY_LABELS[id as keyof typeof PRIORITY_LABELS] ?? id} />
            <HorizontalChart title="Backlog por categoria" rows={data.distributions.category} label={id => CATEGORY_LABELS[id as keyof typeof CATEGORY_LABELS] ?? id} />
          </div>
          <div className="dashboard__grid"><HoursChart rows={data.demand.hours} /><Distribution title="Demanda por dia da semana" rows={data.demand.weekdays} label={id => WEEKDAYS[Number(id) - 1]} /></div>
        </section>

        {(data.coverage.resolvedWithoutStructuredHistory > 0 || data.coverage.conflictingResolutionCycles > 0) && <details className="manager-help"><summary>Limitações de cobertura do histórico</summary><p>{data.coverage.resolvedWithoutStructuredHistory} chamados resolvidos sem autoria comprovada no ciclo atual e {data.coverage.conflictingResolutionCycles} ciclos contraditórios. Esses casos não atribuem produtividade. Resoluções anteriores comprovadas são preservadas.</p></details>}
        <details className="manager-help"><summary>Limites dos indicadores</summary><p>Não há SLA ou tempo médio estimado a partir de históricos incompletos. Uma reabertura preserva a resolução anterior; uma segunda resolução conta um novo ciclo. Atualize a consulta para acompanhar ações recentes.</p></details>
      </div>}
  </section>
}

function Select({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: [string, string][]; onChange: (name: string, value: string) => void }) {
  return <div className="field"><label className="field__label" htmlFor={`manager-${name}`}>{label}</label><select className="field__input field__select" id={`manager-${name}`} value={value} onChange={event => onChange(name, event.target.value)}>{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></div>
}
function Metric({ label, value, hint, to }: { label: string; value: number; hint: string; to?: string }) {
  const content = <><span className="stat-card__label">{label}</span><strong className="stat-card__value">{value}</strong><span className="stat-card__hint">{hint}{to ? ' · Ver chamados →' : ''}</span></>
  return to ? <Link className="stat-card" to={to}>{content}</Link> : <div className="stat-card">{content}</div>
}
function Distribution({ title, rows, label }: { title: string; rows: Count[]; label: (id: string) => string }) {
  const max = Math.max(1, ...rows.map(row => row.count))
  return <section className="card"><h3 className="card__title">{title}</h3>{rows.length === 0 ? <p className="text-muted">Nenhum chamado com os filtros selecionados.</p> : <ul className="bar-list">{rows.map(row => <li className="bar-list__item" key={String(row._id)}><span className="bar-list__label">{label(String(row._id))}</span><span className="bar-list__track" aria-hidden="true"><span className="bar-list__bar manager-bar" style={{ width: `${row.count / max * 100}%` }} /></span><strong>{row.count}</strong></li>)}</ul>}</section>
}
