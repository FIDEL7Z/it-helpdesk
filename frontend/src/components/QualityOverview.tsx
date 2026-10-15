import type { ManagerDashboard } from '../services/manager'

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/**
 * How requesters answered the resolutions of the period. The denominator is the proved
 * resolutions of the period (same filters as the page); no answer is shown as "sem resposta",
 * never as a bad answer.
 */
export function QualityOverview({ quality }: { quality: ManagerDashboard['quality'] }) {
  return (
    <section className="card incidents-overview quality-overview" aria-labelledby="manager-quality">
      <h2 id="manager-quality" className="card__title">Qualidade do atendimento</h2>
      {quality.resolutions === 0 ? (
        <p className="text-muted">Nenhuma resolução comprovada no período com estes filtros.</p>
      ) : (
        <dl className="incidents-overview__numbers">
          <div><dt>Resoluções no período</dt><dd>{quality.resolutions}</dd></div>
          <div><dt>Confirmadas pelo solicitante</dt><dd>{quality.confirmed}</dd></div>
          <div><dt>Contestadas (problema continua)</dt><dd>{quality.contested}</dd></div>
          <div><dt>Sem resposta</dt><dd>{quality.awaiting}</dd></div>
          <div><dt>Taxa de resposta</dt><dd>{quality.responseRate === null ? '—' : percent.format(quality.responseRate)}</dd></div>
          <div><dt>Nota média ({quality.ratings} {quality.ratings === 1 ? 'avaliação' : 'avaliações'})</dt><dd>{quality.averageRating === null ? '—' : `${decimal.format(quality.averageRating)} de 5`}</dd></div>
        </dl>
      )}
      <p className="field__hint">
        Base: resoluções comprovadas no período. Taxa de resposta = confirmadas + contestadas, dividido pelas resoluções.
        A avaliação é opcional: ausência de nota não é avaliação negativa. Com filtro de analista, conta as resoluções feitas por essa pessoa, não o responsável atual; use como sinal, não como julgamento individual.
      </p>
    </section>
  )
}
