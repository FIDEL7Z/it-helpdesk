import { TicketModel, type TicketCategory, type TicketPriority } from '../models/ticket.model';
import type { PublicUser } from '../models/user.model';
import { follow, publish } from './incident.service';
import {
  assignTicket,
  changeStatus,
  confirmResolution,
  contestResolution,
  createTicket,
  rateResolution,
  type TicketDetailView,
} from './ticket.service';

/**
 * Clear, fictitious demo scenarios for presentations and documentation screenshots. Every step
 * goes through the same services as the app (validation, revision, audit, cycles), acting as the
 * reserved demo accounts, so the tickets are classified as demonstration data and their history is
 * real for these new tickets. Existing records are never changed: a scenario whose title already
 * exists for its requester is skipped as a whole.
 */

export type DemoRole = 'requester' | 'requester2' | 'tech' | 'tech2';

export type DemoPeople = Partial<Record<DemoRole, PublicUser>> & { requester: PublicUser; tech: PublicUser };

type Step =
  | { action: 'start'; by: DemoRole }
  | { action: 'assign'; to: DemoRole; by: DemoRole }
  | { action: 'resolve'; by: DemoRole; reason?: string }
  | { action: 'confirm'; rating?: number; comment?: string }
  | { action: 'contest'; reason: string }
  | { action: 'publishIncident'; by: DemoRole; title: string; publicMessage: string }
  | { action: 'follow'; who: DemoRole };

export interface DemoScenario {
  requester: DemoRole;
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  answers: { key: string; answer: string }[];
  steps: Step[];
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    requester: 'requester',
    title: 'Impressora do setor administrativo sem conexão',
    description: 'A impressora do administrativo aparece como offline para todo o setor desde a manhã. Já desliguei e liguei de novo.',
    category: 'hardware',
    priority: 'alta',
    answers: [{ key: 'equipment', answer: 'Impressora' }, { key: 'powersOn', answer: 'Sim' }, { key: 'symptom', answer: 'Aparece como offline para todos os computadores do setor.' }],
    steps: [{ action: 'start', by: 'tech' }],
  },
  {
    requester: 'requester',
    title: 'Erro ao iniciar o aplicativo de notas fiscais',
    description: 'Ao abrir o emissor de notas aparece "Falha ao carregar configurações" e o programa fecha. Reiniciei o computador e continua.',
    category: 'software',
    priority: 'media',
    answers: [{ key: 'program', answer: 'Emissor de notas fiscais' }, { key: 'behavior', answer: 'Mostra uma mensagem de erro' }, { key: 'since', answer: 'Hoje' }],
    steps: [{ action: 'start', by: 'tech' }, { action: 'resolve', by: 'tech' }],
  },
  {
    requester: 'requester',
    title: 'Solicitação de acesso ao sistema interno de compras',
    description: 'Preciso aprovar pedidos no sistema de compras, mas a tela de aprovação não aparece para o meu usuário.',
    category: 'acesso',
    priority: 'media',
    answers: [{ key: 'system', answer: 'Sistema interno de compras' }, { key: 'kind', answer: 'Entro, mas não tenho permissão' }],
    steps: [],
  },
  {
    requester: 'requester',
    title: 'Monitor da estação 12 sem imagem',
    description: 'O monitor da estação 12 liga, mas fica com a tela preta. O computador parece funcionar normalmente.',
    category: 'hardware',
    priority: 'baixa',
    answers: [{ key: 'equipment', answer: 'Monitor' }, { key: 'powersOn', answer: 'Sim' }],
    steps: [{ action: 'start', by: 'tech' }, { action: 'resolve', by: 'tech' }, { action: 'confirm', rating: 5, comment: 'Resolvido no mesmo dia, obrigado.' }],
  },
  {
    requester: 'requester',
    title: 'Notebook desligando sozinho durante reuniões',
    description: 'O notebook desliga sem aviso quando estou em videochamada, principalmente depois de meia hora de uso.',
    category: 'hardware',
    priority: 'media',
    answers: [{ key: 'equipment', answer: 'Notebook' }, { key: 'powersOn', answer: 'Liga, mas desliga sozinho' }],
    steps: [{ action: 'start', by: 'tech' }, { action: 'resolve', by: 'tech' }, { action: 'contest', reason: 'Desligou de novo hoje à tarde, durante a reunião das 15h.' }],
  },
  // The scenarios below need the two extra demo accounts; they are skipped when those do not exist.
  {
    requester: 'requester2',
    title: 'Rede cabeada sem conexão no 2º andar',
    description: 'Os computadores ligados por cabo no 2º andar estão sem internet desde as 9h. O Wi-Fi continua funcionando.',
    category: 'rede',
    priority: 'alta',
    answers: [{ key: 'connection', answer: 'Cabo' }, { key: 'behavior', answer: 'Não funciona' }, { key: 'othersAffected', answer: 'Sim' }],
    steps: [
      { action: 'start', by: 'tech' },
      { action: 'publishIncident', by: 'tech', title: 'Rede cabeada fora do ar no 2º andar', publicMessage: 'A equipe de TI identificou uma falha na rede cabeada do 2º andar e está trabalhando para normalizar o acesso. Enquanto isso, use o Wi-Fi.' },
      { action: 'follow', who: 'requester2' },
      { action: 'follow', who: 'tech2' },
    ],
  },
  {
    requester: 'requester2',
    title: 'VPN não conecta no trabalho remoto',
    description: 'Em casa, a VPN fica tentando conectar e não termina. No escritório o computador funciona normalmente.',
    category: 'rede',
    priority: 'alta',
    answers: [{ key: 'connection', answer: 'Wi-Fi' }, { key: 'behavior', answer: 'Não funciona' }, { key: 'othersAffected', answer: 'Não sei' }],
    steps: [],
  },
  {
    requester: 'requester2',
    title: 'Planilha de custos não abre no Excel',
    description: 'A planilha de custos do mês mostra "arquivo corrompido" ao abrir. Versões antigas abrem normalmente.',
    category: 'software',
    priority: 'media',
    answers: [{ key: 'program', answer: 'Excel' }, { key: 'behavior', answer: 'Mostra uma mensagem de erro' }, { key: 'since', answer: 'Nos últimos dias' }],
    steps: [
      { action: 'assign', to: 'tech2', by: 'tech' },
      { action: 'start', by: 'tech2' },
      { action: 'resolve', by: 'tech', reason: 'Recuperei a versão anterior do arquivo enquanto o responsável estava em atendimento externo.' },
    ],
  },
  {
    requester: 'requester2',
    title: 'Teclado sem fio sem resposta',
    description: 'O teclado sem fio parou de responder mesmo depois de trocar as pilhas.',
    category: 'hardware',
    priority: 'baixa',
    answers: [{ key: 'equipment', answer: 'Periférico (mouse, teclado, fone)' }, { key: 'powersOn', answer: 'Sim' }],
    steps: [{ action: 'start', by: 'tech2' }, { action: 'resolve', by: 'tech2' }, { action: 'confirm', rating: 4 }],
  },
];

function rolesOf(scenario: DemoScenario): DemoRole[] {
  const roles = new Set<DemoRole>([scenario.requester]);
  for (const step of scenario.steps) {
    if ('by' in step) roles.add(step.by);
    if (step.action === 'assign') roles.add(step.to);
    if (step.action === 'follow') roles.add(step.who);
  }
  return [...roles];
}

async function runSteps(scenario: DemoScenario, people: DemoPeople, ticket: TicketDetailView): Promise<void> {
  const who = (role: DemoRole) => people[role]!;
  const requester = who(scenario.requester);
  let incidentId: string | null = null;
  for (const step of scenario.steps) {
    if (step.action === 'start') ticket = await changeStatus(ticket.id, 'em_andamento', who(step.by), ticket.revision);
    if (step.action === 'assign') ticket = await assignTicket(ticket.id, who(step.to).id, who(step.by), ticket.revision);
    if (step.action === 'resolve') ticket = await changeStatus(ticket.id, 'resolvido', who(step.by), ticket.revision, step.reason);
    if (step.action === 'confirm') {
      ticket = await confirmResolution(ticket.id, 1, requester);
      if (step.rating) ticket = await rateResolution(ticket.id, 1, step.rating, step.comment, requester);
    }
    if (step.action === 'contest') ticket = await contestResolution(ticket.id, 1, step.reason, requester);
    if (step.action === 'publishIncident') incidentId = (await publish(ticket.id, { title: step.title, publicMessage: step.publicMessage }, who(step.by))).id;
    if (step.action === 'follow' && incidentId) await follow(incidentId, who(step.who));
  }
}

/** Creates the scenarios whose accounts exist and whose title is new for the requester. */
export async function createDemoScenarios(people: DemoPeople): Promise<{ created: string[]; kept: string[]; skipped: string[] }> {
  const result = { created: [] as string[], kept: [] as string[], skipped: [] as string[] };
  for (const scenario of DEMO_SCENARIOS) {
    if (rolesOf(scenario).some((role) => !people[role])) {
      result.skipped.push(scenario.title);
      continue;
    }
    const requester = people[scenario.requester]!;
    if (await TicketModel.exists({ requester: requester.id, title: scenario.title })) {
      result.kept.push(scenario.title);
      continue;
    }
    const ticket = await createTicket({
      title: scenario.title,
      description: scenario.description,
      category: scenario.category,
      priority: scenario.priority,
      intake: { answers: scenario.answers },
    }, requester);
    await runSteps(scenario, people, ticket);
    result.created.push(scenario.title);
  }
  return result;
}
