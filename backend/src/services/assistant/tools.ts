import { z } from 'zod';
import { can } from '../../auth/permissions';
import { HttpError } from '../../errors/http-error';
import type { TicketEventType, TicketStatus } from '../../models/ticket.model';
import type { PublicUser } from '../../models/user.model';
import { normalizeForSearch } from '../article.service';
import type { ManagerFilters } from '../manager.service';
import { getTicket, listTickets, type TicketSummaryView } from '../ticket.service';
import {
  SOURCE_LIMITS, STATUS, SUBJECT, articles, clip, consumption, date, incidents, keywords, management,
  seesManagerView, singular, stock, type AssistantSource, type Draft,
} from './sources';

/*
 * Read-only tools the model may ask for. The model only sees the declarations of the tools this
 * person's role allows; every call is checked again here (role, then strict arguments) and runs the
 * same services as the pages, with the person from the JWT. Arguments never carry identity: a
 * userId, role or department sent by the model is rejected. Nothing here changes data.
 */

export interface ToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

interface AssistantTool<Args> {
  name: string;
  /** What the person sees under the answer ("Consultou: ..."). */
  label: string;
  allowed(actor: PublicUser): boolean;
  description(actor: PublicUser): string;
  parameters: Record<string, unknown>;
  args: z.ZodType<Args>;
  run(actor: PublicUser, args: Args): Promise<Draft[]>;
}

const PERIODS = { hoje: 'today', semana: 'week', mes: 'month', ano: 'year' } as const satisfies Record<string, ManagerFilters['period']>;
const SITUATIONS = { aguardando: 'aberto', em_atendimento: 'em_andamento', resolvido: 'resolvido' } as const satisfies Record<string, TicketStatus>;
const EVENTS: Record<TicketEventType, string> = {
  created: 'aberto', updated: 'editado', status_changed: 'situação alterada', reopened: 'reaberto', assigned: 'responsável definido',
  resolved: 'resolvido', resolution_confirmed: 'resolução respondida', resolution_rated: 'resolução avaliada',
};

const term = z.string().trim().min(2).max(80);
const periodArg = z.enum(['hoje', 'semana', 'mes', 'ano']).default('mes');
const PERIOD_SCHEMA = { type: 'string', enum: Object.keys(PERIODS), description: 'Período: hoje, semana, mes (padrão) ou ano.' };
const TERM_SCHEMA = (what: string) => ({ type: 'object', properties: { termo: { type: 'string', description: what } }, required: ['termo'] });

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
      : 'Lista chamados que a pessoa pode ver na fila da equipe, do mais recente para o mais antigo, com situação, responsável e datas.',
    parameters: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Palavra do título, opcional (ex.: "teclado").' },
        situacao: { type: 'string', enum: Object.keys(SITUATIONS), description: 'Filtra pela situação, opcional.' },
        quantidade: { type: 'integer', minimum: 1, maximum: 5, description: 'Quantos chamados, de 1 a 5 (padrão 3).' },
      },
    },
    args: z.strictObject({ busca: term.optional(), situacao: z.enum(['aguardando', 'em_atendimento', 'resolvido']).optional(), quantidade: z.number().int().min(1).max(5).default(3) }),
    run: async (actor, { busca, situacao, quantidade }) => {
      const { tickets } = await listTickets({ page: 1, limit: quantidade, sort: 'newest', ...(busca && { search: busca }), ...(situacao && { status: SITUATIONS[situacao] }) }, actor);
      return tickets.map((ticket) => ticketDraft(ticket, actor));
    },
  } satisfies AssistantTool<{ busca?: string; situacao?: keyof typeof SITUATIONS; quantidade: number }>,
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
    description: () => 'Consulta o saldo de materiais e equipamentos do estoque (disponíveis para entrega, reservados, com defeito, mínimo) ou a situação dos equipamentos com patrimônio.',
    parameters: TERM_SCHEMA('Material ou equipamento, por exemplo "teclado" ou "notebook".'),
    args: z.strictObject({ termo: term }),
    run: (_actor, { termo }) => stock(searchWords(termo)),
  } satisfies AssistantTool<{ termo: string }>,
  {
    name: 'consumo_por_departamento',
    label: 'Consumo por departamento',
    allowed: (actor) => can(actor.role, 'inventory:insights'),
    description: () => 'Consumo de materiais entregues por departamento no período, os materiais mais entregues e o que está abaixo do estoque mínimo (dados operacionais).',
    parameters: { type: 'object', properties: { periodo: PERIOD_SCHEMA } },
    args: z.strictObject({ periodo: periodArg }),
    run: (_actor, { periodo }) => consumption(PERIODS[periodo]),
  } satisfies AssistantTool<{ periodo: keyof typeof PERIODS }>,
  {
    name: 'indicadores_atendimento',
    label: 'Indicadores de atendimento',
    allowed: seesManagerView,
    description: () => 'Indicadores da gestão: chamados pendentes e sem responsável, carga e resoluções por pessoa da equipe e qualidade (confirmações, contestações, avaliações) no período.',
    parameters: { type: 'object', properties: { periodo: PERIOD_SCHEMA } },
    args: z.strictObject({ periodo: periodArg }),
    run: (_actor, { periodo }) => management(PERIODS[periodo]),
  } satisfies AssistantTool<{ periodo: keyof typeof PERIODS }>,
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

/**
 * Runs one tool call for the authenticated person. Returns what the model may read: numbered
 * sources, "nothing found", or an error it must explain. Never throws for a refused call.
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
  let drafts: Draft[];
  try {
    drafts = await tool.run(actor, parsed.data);
  } catch {
    console.error(`[assistant] tool ${tool.name} failed`);
    return { erro: 'A consulta falhou. Diga que não foi possível consultar agora.' };
  }
  const found = drafts.slice(0, 5).map((draft) => collector.add(draft)).filter((source): source is AssistantSource => source !== null);
  if (!found.length) return { resultado: 'Nenhum registro encontrado.' };
  return { fontes: found.map(({ id, kind, title, text }) => ({ id, tipo: kind, titulo: title, dados: text })) };
}
