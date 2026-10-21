import { env } from '../../config/env';
import { TicketModel, type TicketCategory } from '../../models/ticket.model';
import type { PublicUser } from '../../models/user.model';
import { inventoryInsights } from '../inventory-insights.service';
import { getManagerDashboard } from '../manager.service';
import { buildTicketFilter } from '../ticket.service';
import { startOfLocalDay, variation, type ResolvedPeriod } from './periods';
import { SUBJECT } from './sources';

/*
 * Numbers for the assistant's analyses, computed here from the same services as the management view
 * (getManagerDashboard, inventoryInsights) with operational data only. The model receives these
 * structured results and explains them; it never computes or invents a figure. Variations are
 * computed here too (variation(): no percent when the base is zero).
 */

type Dashboard = Awaited<ReturnType<typeof getManagerDashboard>>;

const OPERATIONAL = { period: 'week', dataOrigin: 'operational' } as const;
const category = (key: string | number | null) => SUBJECT[key as TicketCategory] ?? 'Sem categoria';
const ticketNumber = (id: string) => `#${id.slice(-6)}`;
const percent = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 10);

const READING_NOTES = [
  'Resoluções contam só as que estão comprovadas no histórico (quem resolveu e quando).',
  'Pendentes são a fila de agora, não do período.',
  'Quantidade de chamados não mede sozinha a qualidade do trabalho de ninguém: complexidade e prioridade variam.',
];

function people(dashboard: Dashboard) {
  return dashboard.team
    .filter((member) => member.active && (member.role === 'ti' || member.resolutions > 0 || member.pending > 0))
    .map((member) => ({
      nome: member.name,
      perfil: member.role,
      resolucoes_no_periodo: member.resolutions,
      reaberturas_no_periodo: member.reopenings,
      pendentes_agora: member.pending,
      em_andamento_agora: member.inProgress,
      alta_prioridade_pendente_agora: member.highPriority,
    }));
}

function quality(dashboard: Dashboard) {
  const q = dashboard.quality;
  return {
    resolucoes_medidas: q.resolutions,
    confirmadas_pelo_solicitante: q.confirmed,
    contestadas: q.contested,
    sem_resposta: q.awaiting,
    taxa_de_resposta_percentual: percent(q.responseRate),
    avaliacoes: q.ratings,
    nota_media: q.averageRating === null ? null : Math.round(q.averageRating * 10) / 10,
  };
}

function balance(dashboard: Dashboard) {
  const w = dashboard.workloadBalance;
  return {
    carga_desigual: w.uneven,
    media_de_pendentes_por_pessoa: Math.round(w.average * 10) / 10,
    mais_pendentes: w.highest ? { pessoas: w.highest.names, pendentes: w.highest.pending } : null,
    menos_pendentes: w.lowest ? { pessoas: w.lowest.names, pendentes: w.lowest.pending } : null,
  };
}

const window = (period: ResolvedPeriod) => ({ start: period.start, end: period.end });

/** Team productivity in a period: who resolved what, and the queue each person holds now. */
export async function teamProductivity(period: ResolvedPeriod, now = new Date()) {
  const dashboard = await getManagerDashboard(OPERATIONAL, now, window(period));
  return {
    periodo: period.label,
    fuso_horario: period.timezone,
    no_periodo: {
      chamados_abertos: dashboard.period.created,
      resolucoes: dashboard.period.resolutions,
      chamados_resolvidos: dashboard.period.resolvedTickets,
      reaberturas: dashboard.period.reopenings,
    },
    por_pessoa: people(dashboard),
    fila_agora: { pendentes: dashboard.current.backlog, em_andamento: dashboard.current.inProgress, sem_responsavel: dashboard.current.unassigned },
    equilibrio_de_carga_agora: balance(dashboard),
    qualidade_das_resolucoes_do_periodo: quality(dashboard),
    como_ler: READING_NOTES,
  };
}

/** The same measures in two periods, with the variation computed here. */
export async function comparePeriods(current: ResolvedPeriod, previous: ResolvedPeriod, now = new Date()) {
  const [after, before, stockAfter, stockBefore] = await Promise.all([
    getManagerDashboard(OPERATIONAL, now, window(current)),
    getManagerDashboard(OPERATIONAL, now, window(previous)),
    inventoryInsights({ period: 'week', dataOrigin: 'operational' }, now, window(current)),
    inventoryInsights({ period: 'week', dataOrigin: 'operational' }, now, window(previous)),
  ]);
  const names = [...new Set([...people(after), ...people(before)].map((row) => row.nome))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const resolved = (dashboard: Dashboard, name: string) => dashboard.team.find((member) => member.name === name)?.resolutions ?? 0;
  const categories = [...new Set([...after.demand.categories, ...before.demand.categories].map((row) => String(row._id)))];
  const created = (dashboard: Dashboard, key: string) => dashboard.demand.categories.find((row) => String(row._id) === key)?.count ?? 0;
  const days = (period: ResolvedPeriod) => Math.round(((period.end.getTime() - period.start.getTime()) / 86_400_000) * 10) / 10;
  return {
    periodo_atual: current.label,
    periodo_anterior: previous.label,
    duracao_em_dias: { atual: days(current), anterior: days(previous) },
    chamados_abertos: variation(before.period.created, after.period.created),
    resolucoes: variation(before.period.resolutions, after.period.resolutions),
    chamados_resolvidos: variation(before.period.resolvedTickets, after.period.resolvedTickets),
    reaberturas: variation(before.period.reopenings, after.period.reopenings),
    resolucoes_por_pessoa: names.map((name) => ({ nome: name, ...variation(resolved(before, name), resolved(after, name)) })),
    chamados_abertos_por_categoria: categories.map((key) => ({ categoria: category(key), ...variation(created(before, key), created(after, key)) }))
      .sort((a, b) => b.atual - a.atual),
    confirmacoes_do_solicitante: variation(before.quality.confirmed, after.quality.confirmed),
    contestacoes: variation(before.quality.contested, after.quality.contested),
    unidades_de_material_entregues: variation(stockBefore.period.deliveredUnits, stockAfter.period.deliveredUnits),
    como_ler: [
      'percentual é null quando o período anterior foi zero (não há base para comparar).',
      'Se o período atual ainda está em andamento, ele pode ter menos tempo que o anterior.',
      'Variação mostra o que mudou, não por que mudou.',
    ],
  };
}

/** What deserves management attention now: old and idle work, unassigned urgency, recurring subjects, stock. */
export async function attentionPoints(now = new Date()) {
  const recent = { start: startOfLocalDay(new Date(now.getTime() - 29 * 86_400_000)), end: now };
  const [dashboard, stock] = await Promise.all([
    getManagerDashboard(OPERATIONAL, now, recent),
    inventoryInsights({ period: 'week', dataOrigin: 'operational' }, now, recent),
  ]);
  const alerts = dashboard.alerts;
  return {
    consultado_em: new Intl.DateTimeFormat('pt-BR', { timeZone: env.APP_TIMEZONE, dateStyle: 'short', timeStyle: 'short' }).format(now),
    alertas_agora: {
      alta_prioridade_sem_responsavel: alerts.highUnassigned,
      [`pendentes_ha_${alerts.ageDays}_dias_ou_mais`]: alerts.oldPending,
      [`sem_movimentacao_da_equipe_ha_${alerts.inactivityDays}_dias_ou_mais`]: alerts.inactive,
      pendentes_sem_responsavel: dashboard.current.unassigned,
      pendentes_no_total: dashboard.current.backlog,
    },
    pendentes_mais_antigos: alerts.oldest.map((row) => ({
      numero: ticketNumber(row.id),
      titulo: row.title,
      dias_desde_a_abertura: row.ageDays,
      dias_sem_movimentacao_da_equipe: row.lastOperationalAt ? Math.floor((now.getTime() - new Date(row.lastOperationalAt).getTime()) / 86_400_000) : null,
    })),
    pendentes_por_categoria_agora: dashboard.distributions.category.map((row) => ({ categoria: category(row._id), quantidade: row.count })),
    abertos_por_categoria_ultimos_30_dias: dashboard.demand.categories.map((row) => ({ categoria: category(row._id), quantidade: row.count })),
    equilibrio_de_carga_agora: balance(dashboard),
    contestacoes_ultimos_30_dias: dashboard.quality.contested,
    estoque_abaixo_do_minimo: stock.stock.belowMinimum.map((row) => ({ produto: row.name, disponivel: row.available, minimo: row.minStock })),
    como_ler: ['São fatos do sistema. Recomendações devem ser apresentadas separadamente, como sugestões.'],
  };
}

/** Materials delivered in a period, by department and product. */
export async function consumptionByDepartment(period: ResolvedPeriod, now = new Date()) {
  const insights = await inventoryInsights({ period: 'week', dataOrigin: 'operational' }, now, window(period));
  return {
    periodo: period.label,
    unidades_entregues: insights.period.deliveredUnits,
    por_departamento: insights.period.byDepartment.map((row) => ({
      departamento: row.name,
      unidades: row.units,
      produtos: insights.period.departmentProducts.find((entry) => entry.departmentId === row.id)?.products.map((p) => ({ produto: p.name, unidades: p.units })) ?? [],
    })),
    produtos_mais_entregues: insights.period.topProducts.map((row) => ({ produto: row.name, unidades: row.units })),
    entregas_ligadas_a_chamados: insights.period.linkedToTickets,
    estoque_abaixo_do_minimo: insights.stock.belowMinimum.map((row) => ({ produto: row.name, disponivel: row.available, minimo: row.minStock })),
    ...(insights.period.deliveredUnits === 0 && { aviso: 'Nenhuma entrega registrada no período nos dados operacionais.' }),
    como_ler: ['Consumir mais não significa desperdício: o número depende do tamanho e da atividade de cada departamento.'],
  };
}

/** Products below the minimum stock, for whoever can read the stock. */
export async function criticalStock(now = new Date()) {
  const insights = await inventoryInsights({ period: 'today', dataOrigin: 'operational' }, now);
  return {
    produtos_ativos: insights.stock.activeProducts,
    abaixo_do_minimo: insights.stock.belowMinimum.map((row) => ({ produto: row.name, disponivel: row.available, minimo: row.minStock })),
    ...(insights.stock.belowMinimum.length === 0 && { aviso: 'Nenhum produto abaixo do mínimo agora.' }),
  };
}

/** Subjects that keep coming back, among the tickets this person can see, created in the period. */
export async function recurringCategories(actor: PublicUser, period: ResolvedPeriod) {
  const rows = await TicketModel.aggregate<{ _id: string; total: number; pending: number }>([
    { $match: { $and: [buildTicketFilter({}, actor), { createdAt: { $gte: period.start, $lt: period.end } }] } },
    { $group: { _id: '$category', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $in: ['$status', ['aberto', 'em_andamento']] }, 1, 0] } } } },
    { $sort: { total: -1, _id: 1 } },
    { $limit: 10 },
  ]);
  return {
    periodo: period.label,
    chamados_no_periodo: rows.reduce((sum, row) => sum + row.total, 0),
    por_categoria: rows.map((row) => ({ categoria: category(row._id), abertos_no_periodo: row.total, ainda_pendentes: row.pending })),
    ...(rows.length === 0 && { aviso: 'Nenhum chamado aberto no período.' }),
  };
}
