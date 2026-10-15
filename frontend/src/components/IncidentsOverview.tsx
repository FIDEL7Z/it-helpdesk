import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { getIncidentIndicators, type IncidentIndicators } from '../services/incidents'
import { STATUS_LABELS } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'

/** Compact manager block: current shared incidents and how many people joined them. */
export function IncidentsOverview({ dataOrigin }: { dataOrigin: string }) {
  const [state, setState] = useState<{ data: IncidentIndicators | null; error: string | null }>({ data: null, error: null })

  useEffect(() => {
    const controller = new AbortController()
    getIncidentIndicators(dataOrigin, controller.signal)
      .then(({ indicators }) => setState({ data: indicators, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ data: null, error: getErrorMessage(error, 'incident') })
      })
    return () => controller.abort()
  }, [dataOrigin])

  const { data } = state

  return (
    <section className="card incidents-overview" aria-labelledby="manager-incidents">
      <h2 id="manager-incidents" className="card__title">Incidentes compartilhados</h2>
      {state.error ? (
        <p className="field__error" role="alert">{state.error}</p>
      ) : !data ? (
        <p className="text-muted" role="status">Carregando incidentes...</p>
      ) : (
        <>
          <dl className="incidents-overview__numbers">
            <div><dt>Ativos</dt><dd>{data.active}</dd></div>
            <div><dt>Pessoas afetadas nos ativos</dt><dd>{data.affectedInActive}</dd></div>
            <div><dt>Novas adesões (30 dias)</dt><dd>{data.newParticipations30Days}</dd></div>
            <div><dt>Encerrados</dt><dd>{data.closed}</dd></div>
          </dl>
          {data.top.length === 0 ? (
            <p className="text-muted">Nenhum incidente ativo nesta origem de dados.</p>
          ) : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Incidentes ativos com mais pessoas afetadas">
              <table className="manager-table">
                <caption className="sr-only">Incidentes ativos, do maior para o menor número de pessoas afetadas</caption>
                <thead><tr><th>Incidente</th><th>Afetados</th><th>Chamado principal</th><th>Responsável</th><th><span className="sr-only">Ação</span></th></tr></thead>
                <tbody>
                  {data.top.map((incident) => (
                    <tr key={incident.id}>
                      <th scope="row">{incident.title}</th>
                      <td>{incident.affectedCount}</td>
                      <td>{incident.ticketStatus ? STATUS_LABELS[incident.ticketStatus] : '—'}</td>
                      <td>{incident.assignee?.name ?? 'Sem responsável'}</td>
                      <td><Link to={`/tickets/${incident.ticketId}`}>Ver chamado</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="field__hint">Pessoas afetadas mostram o alcance do problema; não indicam quantos chamados deixaram de ser abertos.</p>
        </>
      )}
    </section>
  )
}
