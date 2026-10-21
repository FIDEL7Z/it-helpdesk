import { z } from 'zod';
import { can } from '../../auth/permissions';
import { HttpError } from '../../errors/http-error';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketEventType, type TicketStatus } from '../../models/ticket.model';
import type { PublicUser } from '../../models/user.model';
import { normalizeForSearch } from '../article.service';
import { getTicket, listTickets, type TicketSummaryView } from '../ticket.service';
import { attentionPoints, comparePeriods, consumptionByDepartment, criticalStock, recurringCategories, teamProductivity } from './analytics';
import { PERIOD_NAMES, PERIOD_SCHEMA, periodArgs, periodFrom, resolveNamedPeriod, type ResolvedPeriod } from './periods';
import {
  SOURCE_LIMITS, STATUS, SUBJECT, articles, clip, date, incidents, keywords,
  seesManagerView, singular, stock, type AssistantSource, type Draft, type SourceKind,
} from './sources';

/*
 * Read-only tools the model may ask for. The model only sees the declarations of the tools this
 * person's role allows; every call is checked again here (role, then strict arguments) and runs the
 * same services as the pages, with the person from the JWT. Arguments never carry identity: a
 * userId, role or department sent by the model is rejected. Nothing here changes data.
 *
 * Two kinds of result: records (articles, tickets, stock), returned as short numbered sources; and
 * analyses (productivity, comparisons, attention points, consumption), returned as structured numbers
 * computed by the backend (analytics.ts) under one numbered source the answer can cite.
 */

export interface ToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

/** A computed analysis: one citable source and the numbers behind it. */
interface Analysis {
  source: { kind: SourceKind; title: string; link: string };
  data: Record<string, unknown>;
}
type ToolResult = Draft[] | Analysis | { error: string };

interface AssistantTool<Args> {
  name: string;
  /** What the person sees under the answer ("Consultou: ..."). */
  label: string;
  allowed(actor: PublicUser): boolean;
  description(actor: PublicUser): string;
  parameters: Record<string, unknown>;
  args: z.ZodType<Args>;
  run(actor: PublicUser, args: Args): Promise<ToolResult>;
}

const SITUATIONS = { aguardando: 'aberto', em_atendimento: 'em_andamento', resolvido: 'resolvido' } as const satisfies Record<string, TicketStatus>;
const EVENTS: Record<TicketEventType, string> = {
  created: 'aberto', updated: 'editado', status_changed: 'situação alterada', reopened: 'reaberto', assigned: 'responsável definido',
  resolved: 'resolvido', resolution_confirmed: 'resolução respondida', resolution_rated: 'resolução avaliada',
};

const term = z.string().trim().min(2).max(80);
const TERM_SCHEMA = (what: string) => ({ type: 'object', properties: { termo: { type: 'string', description: what } }, required: ['termo'] });
const PERIOD_ONLY = { type: 'object', properties: PERIOD_SCHEMA };

/** Words to search with: content words of the term, or the term itself in the singular. */
const searchWords = (text: string) => {
  const words = keywords(text);
  return words.length ? words : [singular(normalizeForSearch(text).trim())];
};
const requesterView = (actor: PublicUser) => !can(actor.role, 'tickets:view-all');
const ticketNumber = (id: string) => id.slice(-6);

function ticketDraft(ticket: TicketSummaryView, actor: PublicUser): Draft {
  const own = requesterView(actor);
  const facts = [
    `Situação: ${STATUS[ticket.status]}`,
    `Responsável: ${ticket.assignee?.name ?? 'ainda sem responsável'}`,
    `Assunto: ${SUBJECT[ticket.category]}`,
    `Prioridade: ${ticket.priority}`,
    `Aberto em ${date(ticket.createdAt)}`,
    `Última atualização em ${date(ticket.updatedAt)}`,
    ...(ticket.resolvedAt ? [`Resolvido em ${date(ticket.resolvedAt)}`] : []),
    ...('awaitingConfirmation' in ticket && ticket.awaitingConfirmation ? ['Aguardando a pessoa confirmar se a solução funcionou'] : []),
  ];
  return { kind: 'ticket', title: `${own ? 'Seu pedido' : 'Chamado'} #${ticketNumber(ticket.id)}: ${ticket.title}`, text: `${facts.join('. ')}.`, link: `/tickets/${ticket.id}` };
}

/** Runs an analysis for a period taken from the arguments (or the fallback name). */
async function forPeriod(args: z.infer<z.ZodObject<typeof periodArgs>>, fallback: (typeof PERIOD_NAMES)[number], run: (period: ResolvedPeriod) => Promise<Analysis>): Promise<ToolResult> {
  const period = periodFrom(args, fallback);
  return 'error' in period ? period : run(period);
}

const tools = [
  {
    name: 'buscar_artigos',
    label: 'Artigos de ajuda',
    allowed: (actor) => can(actor.role, 'kb:read'),
    description: () => 'Busca artigos publicados da Central de ajuda deste IT Helpdesk (passos de solução de problemas comuns). Use quando a orientação da própria empresa puder ajudar.',
    parameters: TERM_SCHEMA('Assunto a buscar, por exemplo "impressora" ou "wi-fi".'),
    args: z.strictObject({ termo: term }),
    run: (actor, { termo }) => articles(actor, searchWords(termo)),
  } satisfies AssistantTool<{ termo: string }>,
  {
    name: 'consultar_chamados',
    label: 'Chamados',
    allowed: () => true,
    description: (actor) => requesterView(actor)
      ? 'Lista os pedidos de suporte da própria pessoa, do mais recente para o mais antigo, com situação, responsável e datas. Use para "meus pedidos", "meu último chamado" e afins.'
      : 'Lista chamados da fila que a pessoa pode ver, do mais recente para o mais antigo, com situação, responsável e datas. Filtra por situação, prioridade, assunto e responsável ("eu" ou "sem_responsavel").',
    parameters: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Palavra do título, opcional (ex.: "teclado").' },
        situacao: { type: 'string', enum: Object.keys(SITUATIONS), description: 'Filtra pela situação, opcional.' },
        prioridade: { type: 'string', enum: [...TICKET_PRIORITIES], description: 'Filtra pela prioridade, opcional.' },
        categoria: { type: 'string', enum: [...TICKET_CATEGORIES], description: 'Filtra pelo assunto, opcional.' },
        responsavel: { type: 'string', enum: ['eu', 'sem_responsavel'], description: 'Equipe de TI: só os meus, ou só os sem responsável.' },
        quantidade: { type: 'integer', minimum: 1, maximum: 5, description: 'Quantos chamados, de 1 a 5 (padrão 3).' },
      },
    },
    args: z.strictObject({
      busca: term.optional(),
      situacao: z.enum(['aguardando', 'em_atendimento', 'resolvido']).optional(),
      prioridade: z.enum(TICKET_PRIORITIES).optional(),
      categoria: z.enum(TICKET_CATEGORIES).optional(),
      responsavel: z.enum(['eu', 'sem_responsavel']).optional(),
      quantidade: z.number().int().min(1).max(5).default(3),
    }),
    run: async (actor, { busca, situacao, prioridade, categoria, responsavel, quantidade }) => {
      const { tickets } = await listTickets({
        page: 1, limit: quantidade, sort: 'newest',
        ...(busca && { search: busca }), ...(situacao && { status: SITUATIONS[situacao] }),
        ...(prioridade && { priority: prioridade }), ...(categoria && { category: categoria }),
        ...(responsavel && !requesterView(actor) && { assignee: responsavel === 'eu' ? 'me' : 'none' }),
      }, actor);
      return tickets.map((ticket) => ticketDraft(ticket, actor));
    },
  } satisfies AssistantTool<{ busca?: string; situacao?: keyof typeof SITUATIONS; prioridade?: (typeof TICKET_PRIORITIES)[number]; categoria?: (typeof TICKET_CATEGORIES)[number]; responsavel?: 'eu' | 'sem_responsavel'; quantidade: number }>,
  {
    name: 'detalhar_chamado',
    label: 'Detalhe do chamado',
    allowed: () => true,
    description: () => 'Mostra um chamado que a pessoa pode ver: situação, descrição e os últimos passos do histórico. Recebe o número de 6 caracteres que aparece como #abc123 (obtenha-o com consultar_chamados).',
    parameters: { type: 'object', properties: { numero: { type: 'string', description: 'Número do chamado, como "a1b2c3" ou "#a1b2c3".' } }, required: ['numero'] },
    args: z.strictObject({ numero: z.string().trim().regex(/^#?([0-9a-f]{6}|[0-9a-f]{24})$/i) }),
    run: async (actor, { numero }) => {
      const wanted = numero.replace('#', '').toLowerCase();
      // The number is a suffix of the id: look for it only among the tickets this person can list.
      const id = wanted.length === 24 ? wanted : (await listTickets({ page: 1, limit: 100, sort: 'newest' }, actor)).tickets.find((t) => t.id.endsWith(wanted))?.id;
      if (!id) return [];
      try {
        const ticket = await getTicket(id, actor);
        const steps = ticket.history.slice(-5).map((event) => `${date(event.at)}: ${EVENTS[event.type]}${event.message ? ` (${clip(event.message, 160)})` : ''}`);
        const base = ticketDraft(ticket, actor);
        return [{ ...base, text: `${base.text} Descrição: ${clip(ticket.description, 400)} Últimos passos: ${steps.join('; ') || 'nenhum'}.` }];
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.statusCode)) return [];
        throw error;
      }
    },
  } satisfies AssistantTool<{ numero: string }>,
  {
    name: 'problemas_conhecidos',
    label: 'Problemas conhecidos',
    allowed: (actor) => can(actor.role, 'incidents:follow'),
    description: () => 'Lista os problemas coletivos ativos que a TI já está tratando (incidentes publicados), como internet fora do ar para várias pessoas.',
    parameters: { type: 'object', properties: {} },
    args: z.strictObject({}),
    run: (actor) => incidents(actor, []),
  } satisfies AssistantTool<Record<string, never>>,
  {
    name: 'consultar_estoque',
    label: 'Estoque',
    allowed: (actor) => can(actor.role, 'inventory:read'),
    description: () => 'Consulta o saldo de um material ou equipamento do estoque (disponíveis para entrega, reservados, com defeito, mínimo) ou a situação dos equipamentos com patrimônio.',
    parameters: TERM_SCHEMA('Material ou equipamento, por exemplo "teclado" ou "notebook".'),
    args: z.strictObject({ termo: term }),
    run: (_actor, { termo }) => stock(searchWords(termo)),
  } satisfies AssistantTool<{ termo: string }>,
  {
    name: 'estoque_critico',
    label: 'Estoque crítico',
    allowed: (actor) => can(actor.role, 'inventory:read'),
    description: () => 'Lista os produtos que estão abaixo do estoque mínimo agora.',
    parameters: { type: 'object', properties: {} },
    args: z.strictObject({}),
    run: async () => ({ source: { kind: 'stock', title: 'Estoque abaixo do mínimo', link: '/inventory' }, data: await criticalStock() }),
  } satisfies AssistantTool<Record<string, never>>,
  {
    name: 'categorias_recorrentes',
    label: 'Assuntos recorrentes',
    allowed: (actor) => can(actor.role, 'tickets:view-all'),
    description: () => 'Conta os chamados abertos no período por assunto (hardware, rede, acesso...), com quantos ainda estão pendentes, para achar problemas recorrentes.',
    parameters: PERIOD_ONLY,
    args: z.strictObject(periodArgs),
    run: (actor, args) => forPeriod(args, 'ultimos_7_dias', async (period) => ({
      source: { kind: 'metric', title: `Chamados por assunto (${period.label})`, link: '/tickets' },
      data: await recurringCategories(actor, period),
    })),
  } satisfies AssistantTool<z.infer<z.ZodObject<typeof periodArgs>>>,
  {
    name: 'produtividade_equipe',
    label: 'Produtividade da equipe',
    allowed: seesManagerView,
    description: () => 'Analisa o período: chamados abertos, resoluções comprovadas e reaberturas; por pessoa da equipe, as resoluções no período e a fila de agora (pendentes, em andamento, alta prioridade); equilíbrio de carga e qualidade (confirmações, contestações, notas).',
    parameters: PERIOD_ONLY,
    args: z.strictObject(periodArgs),
    run: (_actor, args) => forPeriod(args, 'ultimos_7_dias', async (period) => ({
      source: { kind: 'metric', title: `Produtividade da equipe (${period.label})`, link: '/manager' },
      data: await teamProductivity(period),
    })),
  } satisfies AssistantTool<z.infer<z.ZodObject<typeof periodArgs>>>,
  {
    name: 'comparar_periodos',
    label: 'Comparação de períodos',
    allowed: seesManagerView,
    description: () => 'Compara dois períodos (padrão: últimos 7 dias contra os 7 anteriores): chamados abertos, resoluções, reaberturas, resoluções por pessoa, chamados por assunto, confirmações, contestações e material entregue, com a diferença e o percentual já calculados.',
    parameters: {
      type: 'object',
      properties: {
        atual: { type: 'string', enum: [...PERIOD_NAMES], description: 'Período mais recente (padrão ultimos_7_dias).' },
        anterior: { type: 'string', enum: [...PERIOD_NAMES], description: 'Período de comparação (padrão 7_dias_anteriores; use ontem para comparar com hoje).' },
      },
    },
    args: z.strictObject({ atual: z.enum(PERIOD_NAMES).default('ultimos_7_dias'), anterior: z.enum(PERIOD_NAMES).default('7_dias_anteriores') }),
    run: async (_actor, { atual, anterior }) => {
      const current = resolveNamedPeriod(atual);
      const previous = resolveNamedPeriod(anterior);
      return { source: { kind: 'metric', title: `Comparação: ${current.label} x ${previous.label}`, link: '/manager' }, data: await comparePeriods(current, previous) };
    },
  } satisfies AssistantTool<{ atual: (typeof PERIOD_NAMES)[number]; anterior: (typeof PERIOD_NAMES)[number] }>,
  {
    name: 'pontos_de_atencao',
    label: 'Pontos de atenção',
    allowed: seesManagerView,
    description: () => 'O que merece atenção da gestão agora: alta prioridade sem responsável, pendentes antigos ou sem movimentação, os mais antigos, pendências e aberturas por assunto, carga desigual, contestações e estoque abaixo do mínimo.',
    parameters: { type: 'object', properties: {} },
    args: z.strictObject({}),
    run: async () => ({ source: { kind: 'metric', title: 'Pontos de atenção da operação', link: '/manager' }, data: await attentionPoints() }),
  } satisfies AssistantTool<Record<string, never>>,
  {
    name: 'consumo_por_departamento',
    label: 'Consumo por departamento',
    allowed: (actor) => can(actor.role, 'inventory:insights'),
    description: () => 'Material entregue no período por departamento, com os produtos de cada um, os mais entregues e o que está abaixo do estoque mínimo (dados operacionais).',
    parameters: PERIOD_ONLY,
    args: z.strictObject(periodArgs),
    run: (_actor, args) => forPeriod(args, 'este_mes', async (period) => ({
      source: { kind: 'metric', title: `Consumo por departamento (${period.label})`, link: '/manager' },
      data: await consumptionByDepartment(period),
    })),
  } satisfies AssistantTool<z.infer<z.ZodObject<typeof periodArgs>>>,
] as const;

type AnyTool = AssistantTool<any>;
const TOOLS: readonly AnyTool[] = tools;

/** Declarations sent to the model: only the tools this person's role allows. */
export function toolDeclarationsFor(actor: PublicUser): ToolDeclaration[] {
  return TOOLS.filter((tool) => tool.allowed(actor)).map((tool) => ({ name: tool.name, description: tool.description(actor), parametersJsonSchema: tool.parameters }));
}

export const toolLabel = (name: string) => TOOLS.find((tool) => tool.name === name)?.label ?? null;

/** Sources found during one question, numbered S1, S2... across all of its tool calls. */
export class SourceCollector {
  readonly sources: AssistantSource[] = [];
  readonly used = new Set<string>();
  private chars = 0;

  add(draft: Draft): AssistantSource | null {
    if (this.sources.length >= 12) return null;
    const title = clip(draft.title, SOURCE_LIMITS.titleChars);
    const text = clip(draft.text.replace(/\s+/g, ' ').trim(), SOURCE_LIMITS.textChars);
    if (this.chars + title.length + text.length > 12_000) return null;
    this.chars += title.length + text.length;
    const source = { id: `S${this.sources.length + 1}`, ...draft, title, text };
    this.sources.push(source);
    return source;
  }
}

/** Largest analysis handed to the model; the analyses are bounded well below it. */
const MAX_ANALYSIS_CHARS = 10_000;

/**
 * Runs one tool call for the authenticated person. Returns what the model may read: numbered
 * sources, an analysis, "nothing found", or an error it must explain. Never throws for a refused call.
 */
export async function runTool(actor: PublicUser, name: string, rawArgs: unknown, collector: SourceCollector): Promise<Record<string, unknown>> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool || !tool.allowed(actor)) {
    console.warn(`[assistant] refused tool ${name.slice(0, 40)} for role ${actor.role}`);
    return { erro: 'Esta consulta não está disponível para o perfil desta pessoa. Explique que ela não tem acesso a essa informação.' };
  }
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { erro: 'Argumentos inválidos para esta consulta.' };
  collector.used.add(tool.name);
  let result: ToolResult;
  try {
    result = await tool.run(actor, parsed.data);
  } catch {
    console.error(`[assistant] tool ${tool.name} failed`);
    return { erro: 'A consulta falhou. Diga que não foi possível consultar agora.' };
  }
  if ('error' in result) return { erro: result.error };
  if (!Array.isArray(result)) {
    const json = JSON.stringify(result.data);
    if (json.length > MAX_ANALYSIS_CHARS) return { erro: 'Resultado grande demais. Peça um período menor.' };
    const source = collector.add({ ...result.source, text: result.source.title });
    return { ...(source && { fonte: source.id }), titulo: result.source.title, dados: result.data };
  }
  const found = result.slice(0, 5).map((draft) => collector.add(draft)).filter((source): source is AssistantSource => source !== null);
  if (!found.length) return { resultado: 'Nenhum registro encontrado.' };
  return { fontes: found.map(({ id, kind, title, text }) => ({ id, tipo: kind, titulo: title, dados: text })) };
}
