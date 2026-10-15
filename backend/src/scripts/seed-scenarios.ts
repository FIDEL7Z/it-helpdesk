import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { TicketModel, type TicketCategory, type TicketPriority } from '../models/ticket.model';
import { UserModel, toPublicUser, type PublicUser } from '../models/user.model';
import {
  changeStatus,
  confirmResolution,
  contestResolution,
  createTicket,
  rateResolution,
  type TicketDetailView,
} from '../services/ticket.service';

/**
 * Clear, fictitious demo scenarios for presentations and screenshots, run after `npm run seed`.
 * Every step goes through the same services as the app (validation, revision, audit, cycles), with
 * the reserved demo accounts, so the tickets are classified as demonstration data. Nothing existing
 * is changed: a scenario whose title already exists for the requester is skipped as a whole.
 */

type Step = 'start' | 'resolve' | 'confirm' | 'contest';

interface Scenario {
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  answers: { key: string; answer: string }[];
  steps: Step[];
  rating?: { value: number; comment?: string };
  contestReason?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    title: 'Impressora do setor administrativo sem conexão',
    description: 'A impressora do administrativo aparece como offline para todo o setor desde a manhã. Já desliguei e liguei de novo.',
    category: 'hardware',
    priority: 'alta',
    answers: [{ key: 'equipment', answer: 'Impressora' }, { key: 'powersOn', answer: 'Sim' }, { key: 'symptom', answer: 'Aparece como offline para todos os computadores do setor.' }],
    steps: ['start'],
  },
  {
    title: 'Erro ao iniciar o aplicativo de notas fiscais',
    description: 'Ao abrir o emissor de notas aparece "Falha ao carregar configurações" e o programa fecha. Reiniciei o computador e continua.',
    category: 'software',
    priority: 'media',
    answers: [{ key: 'program', answer: 'Emissor de notas fiscais' }, { key: 'behavior', answer: 'Mostra uma mensagem de erro' }, { key: 'since', answer: 'Hoje' }],
    steps: ['start', 'resolve'],
  },
  {
    title: 'Solicitação de acesso ao sistema interno de compras',
    description: 'Preciso aprovar pedidos no sistema de compras, mas a tela de aprovação não aparece para o meu usuário.',
    category: 'acesso',
    priority: 'media',
    answers: [{ key: 'system', answer: 'Sistema interno de compras' }, { key: 'kind', answer: 'Entro, mas não tenho permissão' }],
    steps: [],
  },
  {
    title: 'Monitor da estação 12 sem imagem',
    description: 'O monitor da estação 12 liga, mas fica com a tela preta. O computador parece funcionar normalmente.',
    category: 'hardware',
    priority: 'baixa',
    answers: [{ key: 'equipment', answer: 'Monitor' }, { key: 'powersOn', answer: 'Sim' }],
    steps: ['start', 'resolve', 'confirm'],
    rating: { value: 5, comment: 'Resolvido no mesmo dia, obrigado.' },
  },
  {
    title: 'Notebook desligando sozinho durante reuniões',
    description: 'O notebook desliga sem aviso quando estou em videochamada, principalmente depois de meia hora de uso.',
    category: 'hardware',
    priority: 'media',
    answers: [{ key: 'equipment', answer: 'Notebook' }, { key: 'powersOn', answer: 'Liga, mas desliga sozinho' }],
    steps: ['start', 'resolve', 'contest'],
    contestReason: 'Desligou de novo hoje à tarde, durante a reunião das 15h.',
  },
];

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_SOLICITANTE_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
});

async function run(scenario: Scenario, requester: PublicUser, tech: PublicUser): Promise<void> {
  let ticket: TicketDetailView = await createTicket({
    title: scenario.title,
    description: scenario.description,
    category: scenario.category,
    priority: scenario.priority,
    intake: { answers: scenario.answers },
  }, requester);
  for (const step of scenario.steps) {
    if (step === 'start') ticket = await changeStatus(ticket.id, 'em_andamento', tech, ticket.revision);
    if (step === 'resolve') ticket = await changeStatus(ticket.id, 'resolvido', tech, ticket.revision);
    if (step === 'confirm') {
      ticket = await confirmResolution(ticket.id, 1, requester);
      if (scenario.rating) ticket = await rateResolution(ticket.id, 1, scenario.rating.value, scenario.rating.comment, requester);
    }
    if (step === 'contest') ticket = await contestResolution(ticket.id, 1, scenario.contestReason ?? 'O problema continua.', requester);
  }
}

async function seedScenarios(): Promise<void> {
  const seedEnv = seedEnvSchema.parse(process.env);
  await mongoose.connect(env.MONGODB_URI);
  const [techUser, requesterUser] = await Promise.all([
    UserModel.findOne({ email: seedEnv.SEED_TI_EMAIL }),
    UserModel.findOne({ email: seedEnv.SEED_SOLICITANTE_EMAIL }),
  ]);
  if (!techUser || !requesterUser) throw new Error('Demo users not found. Run "npm run seed" first.');
  const tech = toPublicUser(techUser);
  const requester = toPublicUser(requesterUser);

  let created = 0;
  for (const scenario of SCENARIOS) {
    if (await TicketModel.exists({ requester: requesterUser._id, title: scenario.title })) {
      console.log(`- ${scenario.title}: already exists, kept as is`);
      continue;
    }
    await run(scenario, requester, tech);
    created += 1;
    console.log(`- ${scenario.title}: created (${scenario.steps.join(' → ') || 'aberto'})`);
  }
  console.log(`Scenario demo seed finished: ${created} created, ${SCENARIOS.length - created} kept`);
}

seedScenarios()
  .catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      console.error(`Invalid seed variables:\n${z.prettifyError(error)}`);
    } else {
      console.error('Scenario demo seed failed:', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
