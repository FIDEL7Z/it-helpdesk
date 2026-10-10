import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { PieChart, TrendLineChart } from '../components/ManagerCharts'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { getManagerDashboard, type ManagerDashboard, type Count } from '../services/manager'
import { CATEGORY_LABELS, PRIORITY_LABELS, STATUS_LABELS } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'

const PERIODS = { today: 'Hoje', week: 'Últimos sete dias', month: 'Mês atual', year: 'Ano atual' }
const ORIGINS = { operational: 'Operacionais', demo: 'Demonstração — dados fictícios', legacy: 'Legado — origem não comprovada' }
const WEEKDAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo']

export function ManagerPage() {
  const { user } = useAuth()
  return user?.role === 'gestor' ? <ManagerContent /> : <Navigate to="/dashboard" replace />
}

function ManagerContent() {
  useDocumentTitle('Visão gerencial')
  const [params, setParams] = useSearchParams()
  const key = params.toString()
  const [retry, setRetry] = useState(0)
  const requestKey = `${key}#${retry}`
  const [state, setState] = useState<{ key: string; data: ManagerDashboard | null; error: string | null }>({ key: '', data: null, error: null })
  const loading = state.key !== requestKey
  const data = loading ? null : state.data
  const error = loading ? null : state.error
  useEffect(() => {
    const controller = new AbortController()
    getManagerDashboard(new URLSearchParams(key), controller.signal)
      .then(({ dashboard }) => setState({ key: requestKey, data: dashboard, error: null }))
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ key: requestKey, data: null, error: getErrorMessage(error) }) })
    return () => controller.abort()
  }, [key, requestKey])
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    setParams(next)
  }
  const origin = params.get('dataOrigin') ?? 'operational'
  const options = state.data?.options
  function tickets(extra: Record<string, string> = {}) {
    const query = new URLSearchParams({ dataOrigin: origin })
    for (const name of ['category', 'priority', 'status', 'requesterId']) { const value = params.get(name); if (value) query.set(name, value) }
    const analyst = params.get('analystId')
    if (analyst) query.set('assigneeId', analyst)
    for (const [name, value] of Object.entries(extra)) query.set(name, value)
    if (extra.assignee) query.delete('assigneeId')
    return `/tickets?${query}`
  }
  return <section className="page manager-page">
    <header className="page__header page__header--with-action">
      <div><p className="eyebrow">Gestão de TI</p><h1 className="page__title">Visão gerencial</h1><p className="page__subtitle">Demanda, carga atual e ações comprovadas da equipe.</p></div>
      <Link className="button button--primary" to={tickets()}>Operação de chamados</Link>
    </header>
    <div className="card manager-filters" aria-label="Filtros gerenciais">
      <Select name="period" label="Período" value={params.get('period') ?? 'month'} options={Object.entries(PERIODS)} onChange={filter} />
      <Select name="dataOrigin" label="Origem dos dados" value={origin} options={Object.entries(ORIGINS)} onChange={filter} />
      <details className="manager-filters__advanced"><summary>Filtros de equipe e classificação</summary><div className="manager-filters__grid">
      <Select name="analystId" label="Analista / gestor operador" value={params.get('analystId') ?? ''} options={[['', 'Toda a equipe'], ...(options?.analysts.map(u => [u.id, u.name] as [string, string]) ?? [])]} onChange={filter} />
      <Select name="requesterId" label="Solicitante" value={params.get('requesterId') ?? ''} options={[['', 'Todos'], ...(options?.requesters.map(u => [u.id, u.name] as [string, string]) ?? [])]} onChange={filter} />
      <Select name="category" label="Categoria atual" value={params.get('category') ?? ''} options={[['', 'Todas'], ...Object.entries(CATEGORY_LABELS)]} onChange={filter} />
      <Select name="priority" label="Prioridade atual" value={params.get('priority') ?? ''} options={[['', 'Todas'], ...Object.entries(PRIORITY_LABELS)]} onChange={filter} />
      <Select name="status" label="Status atual" value={params.get('status') ?? ''} options={[['', 'Todos'], ...Object.entries(STATUS_LABELS)]} onChange={filter} />
      <button className="button button--secondary" onClick={() => setParams(new URLSearchParams())}>Limpar filtros</button>
      </div><p className="field__hint">Analista filtra o responsável na carga atual e nas solicitações; nos eventos, filtra o autor da ação. Categoria, prioridade e status refletem o estado atual do chamado.</p></details>
    </div>
    {loading ? <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando visão gerencial...</div>
      : error ? <div className="alert alert--error" role="alert"><p>{error}</p><button className="button button--secondary" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></div>
      : data && <div className="dashboard">
        <p className={`manager-source${origin === 'demo' ? ' manager-source--demo' : ''}`}>
          {ORIGINS[origin as keyof typeof ORIGINS]} · {new Intl.DateTimeFormat('pt-BR', { timeZone: data.range.timezone, dateStyle: 'short' }).format(new Date(data.range.start))} até {new Intl.DateTimeFormat('pt-BR', { timeZone: data.range.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.asOf))} · {data.range.timezone}
        </p>
        <section aria-labelledby="manager-overview"><h2 id="manager-overview" className="section-title">Visão geral</h2>
          <div className="manager-stats">
            <Metric label="Criados no período" value={data.period.created} hint="Aberturas, independentemente do status atual" />
            <Metric label="Resoluções no período" value={data.period.resolutions} hint={`${data.period.resolvedTickets} chamados distintos · uma resolução por ciclo`} />
            <Metric label="Em andamento agora" value={data.current.inProgress} to={tickets({ status: 'em_andamento' })} hint="Situação atual, sem filtro de criação" />
            <Metric label="Backlog atual" value={data.current.backlog} to={tickets({ pending: 'true' })} hint="Abertos + em andamento; qualquer data de criação" />
            <Metric label="Pendentes sem responsável" value={data.current.unassigned} to={tickets({ assignee: 'none', pending: 'true' })} hint="Chamados abertos ou em andamento" />
            <Metric label="Reaberturas no período" value={data.period.reopenings} hint="Eventos estruturados por chamado e novo ciclo" />
          </div>
        </section>
        <div className="dashboard__grid">
          <PieChart title="Backlog por prioridade" rows={data.distributions.priority} label={id => PRIORITY_LABELS[id as keyof typeof PRIORITY_LABELS] ?? id} />
          <PieChart title="Backlog por categoria" rows={data.distributions.category} label={id => CATEGORY_LABELS[id as keyof typeof CATEGORY_LABELS] ?? id} />
        </div>
        {(data.coverage.resolvedWithoutStructuredHistory > 0 || data.coverage.conflictingResolutionCycles > 0) && <div className="alert alert--info" role="status">
          {data.coverage.resolvedWithoutStructuredHistory} chamados atualmente resolvidos sem evidência válida no ciclo atual; {data.coverage.conflictingResolutionCycles} ciclos com autores contraditórios no período. Resolvidos sem evidência não entram na produtividade; ciclos anteriores comprovados são preservados. Histórico legado permanece disponível no detalhe.
        </div>}
        <section className="card" aria-labelledby="manager-team">
          <h2 id="manager-team" className="card__title">Equipe de suporte</h2>
          <p className="card__description">Ordenada por pendências atuais. Inclui TI e gestores operadores, mesmo sem chamados. Volume e carga não medem qualidade.</p>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Indicadores da equipe, role horizontalmente quando necessário"><table className="manager-table">
            <caption className="sr-only">Carga atual e ações comprovadas por autor no período</caption><thead><tr><th>Analista</th><th>Atribuídos agora</th><th>Em andamento</th><th>Pendentes</th><th>Resoluções</th><th>Participação</th><th>Reaberturas</th><th>Fila</th></tr></thead>
            <tbody>{data.team.map(row => <tr key={row.id}><th scope="row">{row.name}<small>{row.role === 'gestor' ? 'Gestor operador' : row.role === 'ti' ? 'Suporte TI' : 'Participação histórica'}{!row.active ? ' · Inativo / indisponível' : ''}</small></th><td>{row.assigned}</td><td>{row.inProgress}</td><td>{row.pending}</td><td>{row.resolutions}</td><td>{row.participation}</td><td>{row.reopenings}</td><td><Link to={tickets({ assigneeId: row.id })}>Ver chamados</Link></td></tr>)}</tbody>
          </table></div>
          {data.team.length === 0 && <p className="text-muted">Nenhum operador corresponde ao filtro.</p>}
          <p className="field__hint">Atribuídos: todos os status. Pendentes: abertos + em andamento. Participação: chamados distintos com ação do autor no período. Reaberturas: executadas pelo próprio autor; não atribuem culpa ao responsável ou ao resolvedor anterior.</p>
          <Link to={tickets({ assignee: 'none' })}>Consultar chamados sem responsável</Link>
        </section>
        <section className="card" aria-labelledby="manager-requesters">
          <h2 id="manager-requesters" className="card__title">Solicitantes no período</h2><p className="card__description">Até dez maiores volumes de criação. Pendências pertencem aos chamados criados no período; qualquer perfil pode ser solicitante.</p>
          {data.requesters.length === 0 ? <p className="text-muted">Nenhuma solicitação criada neste período com os filtros selecionados.</p> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Ranking de solicitantes"><table className="manager-table"><thead><tr><th>Solicitante</th><th>Solicitações</th><th>Ainda pendentes</th><th>Categorias mais solicitadas</th></tr></thead><tbody>{data.requesters.map(row => <tr key={row.id}><th scope="row"><Link to={tickets({ requesterId: row.id })}>{row.name}</Link></th><td>{row.created}</td><td>{row.pending}</td><td>{row.categories.slice(0, 3).map(c => `${CATEGORY_LABELS[c.category as keyof typeof CATEGORY_LABELS] ?? c.category} (${c.count})`).join(', ')}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card" aria-labelledby="manager-trends"><h2 id="manager-trends" className="card__title">Tendências e horários</h2><p className="card__description">Criação pela data real; resoluções por evento comprovado. Agrupamento {data.range.bucket === 'month' ? 'mensal' : 'diário'} no fuso {data.range.timezone}. Ausência de registros não produz valores simulados.</p>
          <TrendLineChart rows={data.trends} />
          {data.trends.length === 0 ? <p className="text-muted">Sem criações ou resoluções comprovadas no período.</p> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Evolução de chamados"><table className="manager-table manager-table--trends"><thead><tr><th>Período</th><th>Criados</th><th>Resoluções</th><th>Evolução</th></tr></thead><tbody>{data.trends.map(row => <tr key={row.period}><th scope="row">{row.period}</th><td>{row.created}</td><td>{row.resolved}</td><td><div className="trend-bars" aria-hidden="true"><span className="trend-bars__created" style={{ width: `${row.created / Math.max(1, ...data.trends.map(r => Math.max(r.created, r.resolved))) * 100}%` }} /><span className="trend-bars__resolved" style={{ width: `${row.resolved / Math.max(1, ...data.trends.map(r => Math.max(r.created, r.resolved))) * 100}%` }} /></div></td></tr>)}</tbody></table></div>}
          <p className="field__hint">Azul: criados · Verde: resoluções. Uma reabertura preserva a resolução anterior; outra resolução conta um novo ciclo.</p>
        </section>
        <div className="dashboard__grid"><Distribution title="Demanda por hora de criação" rows={data.demand.hours} label={id => `${id.padStart(2, '0')}h`} /><Distribution title="Demanda por dia da semana" rows={data.demand.weekdays} label={id => WEEKDAYS[Number(id) - 1]} /></div>
        <p className="field__hint">Dados consultados no MongoDB. Não há SLA ou tempo médio calculado a partir de históricos incompletos. Atualizações concorrentes podem aparecer na próxima consulta.</p>
        <button className="button button--secondary" onClick={() => setRetry(n => n + 1)}>Atualizar indicadores</button>
      </div>}
  </section>
}

function Select({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: [string, string][]; onChange: (name: string, value: string) => void }) {
  return <div className="field"><label className="field__label" htmlFor={`manager-${name}`}>{label}</label><select className="field__input field__select" id={`manager-${name}`} value={value} onChange={event => onChange(name, event.target.value)}>{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></div>
}
function Metric({ label, value, hint, to }: { label: string; value: number; hint: string; to?: string }) {
  const content = <><span className="stat-card__label">{label}</span><strong className="stat-card__value">{value}</strong><span className="stat-card__hint">{hint}</span></>
  return to ? <Link className="stat-card" to={to}>{content}</Link> : <div className="stat-card">{content}</div>
}
function Distribution({ title, rows, label }: { title: string; rows: Count[]; label: (id: string) => string }) {
  const max = Math.max(1, ...rows.map(row => row.count))
  return <section className="card"><h2 className="card__title">{title}</h2>{rows.length === 0 ? <p className="text-muted">Nenhum chamado com os filtros selecionados.</p> : <ul className="bar-list">{rows.map(row => <li className="bar-list__item" key={String(row._id)}><span className="bar-list__label">{label(String(row._id))}</span><span className="bar-list__track" aria-hidden="true"><span className="bar-list__bar manager-bar" style={{ width: `${row.count / max * 100}%` }} /></span><strong>{row.count}</strong></li>)}</ul>}</section>
}
