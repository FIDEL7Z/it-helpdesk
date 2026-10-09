import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import {
  TicketModel,
  type TicketCategory,
  type TicketEvent,
  type TicketPriority,
  type TicketStatus,
} from '../models/ticket.model';
import { UserModel, type UserDocument } from '../models/user.model';

/**
 * Optional demo data for presentations. It only inserts: existing tickets are never
 * changed or deleted. A demo ticket is identified by requester + title, so running
 * the script again skips what already exists.
 */

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_SOLICITANTE_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
});

interface DemoTicket {
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  daysAgo: number;
  /** Only for open tickets: assigned before work started. */
  assignedWhileOpen?: boolean;
  /** Opened by the IT user instead of the requester. */
  openedByIt?: boolean;
}

const DEMO_TICKETS: DemoTicket[] = [
  {
    title: 'Impressora do 2º andar não imprime',
    description: 'Desde hoje cedo a impressora do 2º andar não responde. Já reiniciei e troquei o cabo.',
    category: 'hardware',
    priority: 'alta',
    status: 'aberto',
    daysAgo: 0,
  },
  {
    title: 'VPN não conecta em home office',
    description: 'Ao tentar conectar na VPN de casa aparece "tempo limite excedido".',
    category: 'acesso',
    priority: 'alta',
    status: 'aberto',
    daysAgo: 1,
  },
  {
    title: 'Solicitação de monitor adicional',
    description: 'Preciso de um segundo monitor para trabalhar com planilhas e relatórios.',
    category: 'hardware',
    priority: 'baixa',
    status: 'aberto',
    daysAgo: 2,
    assignedWhileOpen: true,
  },
  {
    title: 'Wi-Fi instável na sala de reuniões',
    description: 'A conexão cai várias vezes durante as videochamadas na sala de reuniões.',
    category: 'rede',
    priority: 'media',
    status: 'em_andamento',
    daysAgo: 3,
  },
  {
    title: 'Excel fecha ao abrir planilhas grandes',
    description: 'O Excel fecha sozinho ao abrir planilhas com mais de 50 mil linhas.',
    category: 'software',
    priority: 'media',
    status: 'em_andamento',
    daysAgo: 4,
  },
  {
    title: 'Acesso à pasta compartilhada do financeiro',
    description: 'Preciso de acesso de leitura à pasta do financeiro para o fechamento do mês.',
    category: 'acesso',
    priority: 'alta',
    status: 'em_andamento',
    daysAgo: 5,
  },
  {
    title: 'Atualizar antivírus das estações',
    description: 'Atualização programada do antivírus em todas as estações do escritório.',
    category: 'outros',
    priority: 'media',
    status: 'aberto',
    daysAgo: 6,
    openedByIt: true,
  },
  {
    title: 'Troca de senha do e-mail corporativo',
    description: 'Minha senha do e-mail expirou e não consigo redefinir pelo portal.',
    category: 'acesso',
    priority: 'baixa',
    status: 'resolvido',
    daysAgo: 7,
  },
  {
    title: 'Teclado com teclas falhando',
    description: 'As teclas A e S do teclado falham com frequência.',
    category: 'hardware',
    priority: 'baixa',
    status: 'resolvido',
    daysAgo: 9,
  },
  {
    title: 'Instalação do cliente de VPN no notebook novo',
    description: 'Recebi um notebook novo e preciso do cliente de VPN instalado.',
    category: 'software',
    priority: 'media',
    status: 'resolvido',
    daysAgo: 12,
  },
];

const HOUR = 60 * 60 * 1000;

/** History consistent with the final status, as if the real workflow had happened. */
function buildHistory(
  ticket: DemoTicket,
  requester: UserDocument,
  it: UserDocument,
  createdAt: Date,
): TicketEvent[] {
  const at = (hours: number) => new Date(createdAt.getTime() + hours * HOUR);
  const history: TicketEvent[] = [
    { type: 'created', author: requester._id, message: 'Chamado aberto', at: createdAt },
  ];

  if (ticket.assignedWhileOpen) {
    history.push({ type: 'assigned', author: it._id, message: `Responsável definido: ${it.name}`, at: at(1) });
  }

  if (ticket.status !== 'aberto') {
    history.push(
      {
        type: 'status_changed',
        author: it._id,
        message: 'Status alterado de Aberto para Em andamento',
        at: at(1),
      },
      { type: 'assigned', author: it._id, message: `Responsável definido: ${it.name}`, at: at(1) },
    );
  }

  if (ticket.status === 'resolvido') {
    history.push({
      type: 'status_changed',
      author: it._id,
      message: 'Status alterado de Em andamento para Resolvido',
      at: at(20),
    });
  }

  return history;
}

async function findDemoUser(email: string): Promise<UserDocument> {
  const user = await UserModel.findOne({ email });
  if (!user) {
    throw new Error(`Demo user ${email} not found. Run "npm run seed" first.`);
  }
  return user;
}

async function seedDemo(): Promise<void> {
  const seedEnv = seedEnvSchema.parse(process.env);

  await mongoose.connect(env.MONGODB_URI);

  const requester = await findDemoUser(seedEnv.SEED_SOLICITANTE_EMAIL);
  const it = await findDemoUser(seedEnv.SEED_TI_EMAIL);

  let created = 0;
  console.log('Seeding demo tickets:');

  for (const demo of DEMO_TICKETS) {
    const owner = demo.openedByIt ? it : requester;

    if (await TicketModel.exists({ requester: owner._id, title: demo.title })) {
      console.log(`- ${demo.title}: already exists, skipped`);
      continue;
    }

    // Created 2 hours before "daysAgo" so every history event is already in the past.
    const createdAt = new Date(Date.now() - demo.daysAgo * 24 * HOUR - 2 * HOUR);
    const history = buildHistory(demo, owner, it, createdAt);
    const hasAssignee = demo.assignedWhileOpen || demo.status !== 'aberto';

    const ticket = new TicketModel({
      title: demo.title,
      description: demo.description,
      category: demo.category,
      priority: demo.priority,
      status: demo.status,
      requester: owner._id,
      assignee: hasAssignee ? it._id : null,
      history,
      createdAt,
      updatedAt: history[history.length - 1].at,
    });
    // timestamps: false keeps the past dates set above instead of "now".
    await ticket.save({ timestamps: false });

    created += 1;
    console.log(`- ${demo.title}: created`);
  }

  console.log(`Demo seed finished: ${created} created, ${DEMO_TICKETS.length - created} skipped`);
}

seedDemo()
  .catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      console.error(`Invalid seed variables:\n${z.prettifyError(error)}`);
    } else {
      console.error('Demo seed failed:', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
