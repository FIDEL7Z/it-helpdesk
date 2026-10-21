import { can } from '../../auth/permissions';
import type { TicketCategory, TicketStatus } from '../../models/ticket.model';
import type { PublicUser } from '../../models/user.model';
import { getArticle, normalizeForSearch, searchPublished } from '../article.service';
import { listProducts } from '../catalog.service';
import { getDashboardSummary } from '../dashboard.service';
import { listActive } from '../incident.service';
import { inventoryInsights } from '../inventory-insights.service';
import { getManagerDashboard, type ManagerFilters } from '../manager.service';
import { listTickets } from '../ticket.service';

/**
 * What the assistant may tell this person, read through the same services (and the same scope)
 * as the pages: published articles, public incidents, tickets the person can list, and stock or
 * management numbers only with the permission that opens those pages. The question only picks
 * WHICH of the allowed data is relevant; it never widens what can be read.
 */

export type SourceKind = 'article' | 'incident' | 'ticket' | 'stock' | 'metric' | 'guide';

export interface AssistantSource {
  id: string;
  kind: SourceKind;
  title: string;
  text: string;
  /** Page in the app where the person can check it (and that applies the same permissions). */
  link: string | null;
}

export const SOURCE_LIMITS = Object.freeze({ count: 8, titleChars: 120, textChars: 1_200, totalChars: 6_000 });

export const STATUS: Record<TicketStatus, string> = { aberto: 'aguardando atendimento', em_andamento: 'em atendimento', resolvido: 'resolvido' };
export const SUBJECT: Record<TicketCategory, string> = {
  hardware: 'Computador ou equipamento', software: 'Programas e aplicativos', rede: 'Internet e conexão', acesso: 'Contas e permissões', outros: 'Outro problema',
};
const STOP = new Set([
  ...'a o e de da do das dos em no na nos nas um uma uns umas para por com sem que qual quais quanto quantos quantas como onde quando meu minha meus minhas seu sua isso esse essa este esta tem temos ter ser estar esta estao foi pra pro nao sim mais menos muito muita hoje agora ainda sobre entre ate pelo pela pelos pelas eu voce voces nos ele ela eles elas favor preciso precisa queria quero gostaria posso pode ajuda ajudar'.split(' '),
  // Generic verbs and nouns that appear in every guide and would pull unrelated articles.
  ...'parou funciona funcionar funcionando faco fazer feito problema problemas consigo conseguir consegue saber acontece aconteceu ultimo ultima algum alguma'.split(' '),
  // How to ask for help is answered by the system guide, not by every article that mentions support.
  ...'suporte solicito solicitar solicitacao pedir peco abrir abro registrar'.split(' '),
]);

/** Portuguese plural to singular, enough for "contains" searches: teclados → teclado, botoes → botao. */
export function singular(word: string): string {
  if (word.length <= 4) return word;
  if (word.endsWith('oes') || word.endsWith('aes')) return `${word.slice(0, -3)}ao`;
  if (word.endsWith('ais')) return `${word.slice(0, -3)}al`;
  if (word.endsWith('eis')) return `${word.slice(0, -3)}el`;
  if (word.endsWith('ns')) return `${word.slice(0, -2)}m`;
  return word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** Content words of the question, without accents (the same normalization as the article search), in the singular. */
export function keywords(question: string, max = 5): string[] {
  const words = normalizeForSearch(question).split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !STOP.has(word)).map(singular);
  return [...new Set(words)].slice(0, max);
}

const mentions = (normalized: string, pattern: RegExp) => pattern.test(normalized);
const STOCK_WORDS = /estoque|saldo|disponiv|teclad|mouse|monitor|notebook|headset|fone|cabo|material|materia|equipament|patrimon|reserv|repor|reposic/;
const CONSUMPTION_WORDS = /consumo|consumid|setor|departament|entreg|repor|reposic|minimo|defeit/;
const MANAGEMENT_WORDS = /equipe|analista|carga|qualidade|avaliac|confirm|contest|indicador|backlog|pendent|metric|resolvid|resoluc|desempenho|produtiv|fila/;
const TICKET_WORDS = /chamado|pedido|status|andamento|aberto|resolvid|meu|minha/;
const INCIDENT_WORDS = /incidente|problema conhecido|fora do ar|instabil|todo mundo|geral/;
const HOW_TO_REQUEST = /solicit|\babrir\b|\babro\b|\bpedir\b|\bpeco\b|suporte|registr|novo (pedido|chamado)/;

export function period(normalized: string): ManagerFilters['period'] {
  if (/\bhoje\b/.test(normalized)) return 'today';
  if (/semana/.test(normalized)) return 'week';
  if (/\bano\b|anual/.test(normalized)) return 'year';
  return 'month';
}
export const PERIOD_LABEL: Record<ManagerFilters['period'], string> = { today: 'hoje', week: 'nesta semana', month: 'neste mês', year: 'neste ano' };

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
export const date = (value: Date | null | undefined) => (value ? new Date(value).toLocaleDateString('pt-BR') : 'sem data');

export type Draft = Omit<AssistantSource, 'id'>;

/** How to open a request, in the words of the screens the person sees (NewTicketPage, TicketsPage). */
export function guide(actor: PublicUser): Draft {
  if (!can(actor.role, 'tickets:view-all')) {
    return {
      kind: 'guide',
      title: 'Como pedir suporte no IT Helpdesk',
      text: 'Na página Início, clique em Solicitar suporte. Escolha com o que você precisa de ajuda (Computador ou equipamento, Programas e aplicativos, Internet e conexão, Contas e permissões ou Outro problema) e veja as orientações que podem resolver. Se o problema continuar, preencha Assunto e O que aconteceu?; onde está o problema e a prioridade sugerida são opcionais. Envie com Enviar solicitação. A equipe de TI recebe o pedido e define a prioridade; você acompanha cada etapa em Meus pedidos e, quando a TI resolver, confirma se deu certo ou avisa que o problema continua.',
      link: '/tickets/new',
    };
  }
  return {
    kind: 'guide',
    title: 'Como registrar um chamado',
    text: 'Em Chamados (ou na página Atendimento), clique em Abrir chamado. Escolha o assunto, preencha Assunto e O que aconteceu? e, se quiser, onde está o problema, o equipamento envolvido e a prioridade sugerida. Confirme com Abrir chamado; ele entra na fila da equipe.',
    link: '/tickets/new',
  };
}

export async function articles(actor: PublicUser, words: string[]): Promise<Draft[]> {
  const hits = new Map<string, { score: number; title: string }>();
  for (const word of words) {
    const { articles: found } = await searchPublished({ q: word, page: 1, limit: 3 });
    for (const article of found) {
      const entry = hits.get(article.id) ?? { score: 0, title: article.title };
      entry.score += 1;
      hits.set(article.id, entry);
    }
  }
  const best = [...hits.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 2);
  const drafts: Draft[] = [];
  for (const [id] of best) {
    // Only published articles reach here (searchPublished); getArticle applies the reader's own rule.
    const article = await getArticle(id, actor);
    drafts.push({ kind: 'article', title: article.title, text: `${article.summary}\n${article.body ?? ''}`, link: `/help/${article.id}` });
  }
  return drafts;
}

export async function incidents(actor: PublicUser, words: string[]): Promise<Draft[]> {
  const active = await listActive(actor);
  const scored = active.map((incident) => {
    const haystack = normalizeForSearch(`${incident.title} ${incident.publicMessage}`);
    return { incident, score: words.filter((word) => haystack.includes(word)).length };
  }).filter((row) => row.score > 0 || words.length === 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, 2).map(({ incident }) => ({
    kind: 'incident',
    title: `Problema conhecido: ${incident.title}`,
    text: `${incident.publicMessage} Situação: a TI está tratando. Pessoas afetadas: ${incident.affectedCount}. Publicado em ${date(incident.publishedAt)}.`,
    link: '/dashboard',
  }));
}

export async function tickets(actor: PublicUser, words: string[], asked: boolean): Promise<Draft[]> {
  // Nothing to look for and no question about tickets (a greeting, general advice): no tickets.
  if (!words.length && !asked) return [];
  // Same scope as the ticket list: a requester sees only their own tickets.
  const own = !can(actor.role, 'tickets:view-all');
  const searches = words.length ? words.slice(0, 3) : [undefined];
  const seen = new Map<string, Draft>();
  for (const search of searches) {
    const { tickets: found } = await listTickets({ page: 1, limit: 3, ...(search && { search }) }, actor);
    for (const ticket of found) {
      if (seen.has(ticket.id)) continue;
      const assignee = ticket.assignee?.name ? `, com ${ticket.assignee.name}` : '';
      seen.set(ticket.id, {
        kind: 'ticket',
        title: `${own ? 'Seu pedido' : 'Chamado'} #${ticket.id.slice(-6)}: ${ticket.title}`,
        text: `Situação: ${STATUS[ticket.status]}${assignee}. Assunto: ${SUBJECT[ticket.category]}. Prioridade: ${ticket.priority}. Aberto em ${date(ticket.createdAt)}.`,
        link: `/tickets/${ticket.id}`,
      });
    }
  }
  // Without matching words, only when the question is about tickets: the latest ones in scope.
  if (seen.size === 0 && asked && words.length) {
    const { tickets: latest } = await listTickets({ page: 1, limit: 3 }, actor);
    for (const ticket of latest) {
      seen.set(ticket.id, { kind: 'ticket', title: `${own ? 'Seu pedido' : 'Chamado'} #${ticket.id.slice(-6)}: ${ticket.title}`, text: `Situação: ${STATUS[ticket.status]}. Aberto em ${date(ticket.createdAt)}.`, link: `/tickets/${ticket.id}` });
    }
  }
  return [...seen.values()].slice(0, 3);
}

export async function stock(words: string[]): Promise<Draft[]> {
  const seen = new Map<string, Draft>();
  for (const word of words) {
    const { products } = await listProducts({ q: word, status: 'active', page: 1, limit: 3 });
    for (const product of products) {
      if (seen.has(product.id)) continue;
      const levels = product.stock
        ? `Disponíveis para entrega: ${product.stock.available}. Em estoque: ${product.stock.onHand}. Reservados: ${product.stock.reserved}. Com defeito: ${product.stock.defective}. Mínimo: ${product.minStock}.`
        : `Equipamentos por situação: ${Object.entries(product.assets ?? {}).map(([status, count]) => `${status} ${count}`).join(', ') || 'nenhum cadastrado'}.`;
      seen.set(product.id, { kind: 'stock', title: `Estoque: ${product.name}`, text: levels, link: `/inventory/products/${product.id}` });
    }
  }
  return [...seen.values()].slice(0, 3);
}

export async function consumption(chosen: ManagerFilters['period']): Promise<Draft[]> {
  const insights = await inventoryInsights({ period: chosen, dataOrigin: 'operational' });
  const list = (rows: { name: string; units: number }[]) => rows.length ? rows.map((row) => `${row.name}: ${row.units}`).join('; ') : 'nenhum registro';
  return [
    { kind: 'metric', title: `Consumo de materiais por setor (${PERIOD_LABEL[chosen]})`, text: `Unidades entregues no período: ${insights.period.deliveredUnits}. Por departamento: ${list(insights.period.byDepartment)}. Materiais mais entregues: ${list(insights.period.topProducts)}. Dados operacionais, como a visão gerencial abre: registros de demonstração e entregas estornadas não contam.`, link: '/manager' },
    { kind: 'metric', title: 'Estoque abaixo do mínimo', text: insights.stock.belowMinimum.length ? insights.stock.belowMinimum.map((row) => `${row.name}: ${row.available} disponível(is), mínimo ${row.minStock}`).join('; ') : 'Nenhum material abaixo do mínimo.', link: '/inventory' },
  ];
}

export async function management(chosen: ManagerFilters['period']): Promise<Draft[]> {
  const dashboard = await getManagerDashboard({ period: chosen, dataOrigin: 'operational' });
  const team = dashboard.team.slice(0, 6).map((member) => `${member.name}: ${member.pending} pendentes (${member.highPriority} de alta), ${member.resolutions} resoluções no período`).join('; ');
  const quality = dashboard.quality;
  const rate = quality.responseRate === null ? 'sem respostas' : `${Math.round(quality.responseRate * 100)}%`;
  return [
    { kind: 'metric', title: 'Situação atual dos chamados', text: `Pendentes: ${dashboard.current.backlog} (em andamento: ${dashboard.current.inProgress}, sem responsável: ${dashboard.current.unassigned}). Alta prioridade sem responsável: ${dashboard.alerts.highUnassigned}. Dados operacionais.`, link: '/manager' },
    { kind: 'metric', title: `Equipe (${PERIOD_LABEL[chosen]})`, text: team || 'Nenhum operador com chamados no período.', link: '/manager' },
    { kind: 'metric', title: `Qualidade do atendimento (${PERIOD_LABEL[chosen]})`, text: `Resoluções medidas: ${quality.resolutions}. Confirmadas: ${quality.confirmed}. Contestadas: ${quality.contested}. Sem resposta: ${quality.awaiting}. Taxa de resposta: ${rate}. Avaliações: ${quality.ratings}${quality.averageRating === null ? '' : `, média ${quality.averageRating.toFixed(1)}`}.`, link: '/manager' },
  ];
}

/** The /dashboard/manager route is gestor-only (requireRole); the assistant follows the same rule. */
export const seesManagerView = (actor: PublicUser) => actor.role === 'gestor';

export async function gatherSources(actor: PublicUser, question: string): Promise<AssistantSource[]> {
  const normalized = normalizeForSearch(question);
  const words = keywords(question);
  const drafts: Draft[] = [];

  if (seesManagerView(actor) && mentions(normalized, MANAGEMENT_WORDS)) drafts.push(...await management(period(normalized)));
  if (can(actor.role, 'inventory:insights') && mentions(normalized, CONSUMPTION_WORDS)) drafts.push(...await consumption(period(normalized)));
  if (can(actor.role, 'inventory:read') && mentions(normalized, STOCK_WORDS)) drafts.push(...await stock(words));
  if (can(actor.role, 'incidents:follow') && (words.length || mentions(normalized, INCIDENT_WORDS))) drafts.push(...await incidents(actor, words));
  if (mentions(normalized, HOW_TO_REQUEST)) drafts.push(guide(actor));
  if (can(actor.role, 'kb:read')) drafts.push(...await articles(actor, words));
  drafts.push(...await tickets(actor, words, mentions(normalized, TICKET_WORDS)));

  // Fit the answer service limits: at most 8 sources, short texts, 6,000 characters in total.
  const sources: AssistantSource[] = [];
  let total = 0;
  for (const draft of drafts) {
    if (sources.length === SOURCE_LIMITS.count) break;
    const title = clip(draft.title, SOURCE_LIMITS.titleChars);
    const text = clip(draft.text.replace(/\s+/g, ' ').trim(), Math.min(SOURCE_LIMITS.textChars, SOURCE_LIMITS.totalChars - total - title.length));
    if (text.length < 20) break;
    total += title.length + text.length;
    sources.push({ id: `S${sources.length + 1}`, ...draft, title, text });
  }
  return sources;
}
