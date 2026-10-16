import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { SharedIncidentModel } from '../models/incident.model';
import { TicketModel } from '../models/ticket.model';
import { UserModel, toPublicUser } from '../models/user.model';
import { follow, publish } from '../services/incident.service';

/**
 * Optional demo scenario for Shared Incidents, run after `npm run seed:demo`.
 * It goes through the same service rules as the app (publish + follow), never edits tickets,
 * and can run again: an existing incident or participation is kept as it is.
 * The incident inherits dataOrigin "demo" from its demo ticket.
 */

const DEMO_TICKET_TITLE = 'Wi-Fi instável na sala de reuniões';
const PUBLIC_TEXT = {
  title: 'Instabilidade na rede Wi-Fi',
  publicMessage: 'A equipe de TI identificou uma instabilidade na rede Wi-Fi. Estamos trabalhando para normalizar o acesso.',
};
// Fictitious extra accounts created by the local demo team setup, used only if they exist.
// The main requester (SEED_SOLICITANTE_EMAIL) is left out on purpose, to click "me too" during a demo.
const EXTRA_AFFECTED_EMAILS = ['demo.solicitante2@helpdesk.local', 'demo.ti2@helpdesk.local'];

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_SOLICITANTE_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
});

async function seedIncidents(): Promise<void> {
  const seedEnv = seedEnvSchema.parse(process.env);
  await mongoose.connect(env.MONGODB_URI);

  const [it, requester] = await Promise.all([
    UserModel.findOne({ email: seedEnv.SEED_TI_EMAIL }),
    UserModel.findOne({ email: seedEnv.SEED_SOLICITANTE_EMAIL }),
  ]);
  if (!it || !requester) throw new Error('Demo users not found. Run "npm run seed" first.');

  const ticket = await TicketModel.findOne({ requester: requester._id, title: DEMO_TICKET_TITLE, dataOrigin: 'demo' });
  if (!ticket) throw new Error(`Demo ticket "${DEMO_TICKET_TITLE}" not found. Run "npm run seed:demo" first.`);

  let incident = await SharedIncidentModel.findOne({ ticket: ticket._id });
  if (incident) {
    console.log(`- incident for "${DEMO_TICKET_TITLE}": already exists (${incident.status}), kept as is`);
  } else if (ticket.status === 'resolvido') {
    console.log(`- "${DEMO_TICKET_TITLE}" is resolved; not publishing (reopen it first to demonstrate)`);
    return;
  } else {
    await publish(ticket.id, PUBLIC_TEXT, toPublicUser(it));
    incident = await SharedIncidentModel.findOne({ ticket: ticket._id });
    console.log(`- incident "${PUBLIC_TEXT.title}": published by ${it.email}`);
  }

  if (incident?.status !== 'active') return;
  const extras = await UserModel.find({ email: { $in: EXTRA_AFFECTED_EMAILS } });
  for (const user of extras) {
    // follow() is idempotent: running the seed again does not add people twice.
    await follow(incident.id, toPublicUser(user));
    console.log(`- ${user.email}: following`);
  }
  if (extras.length === 0) console.log('- no extra demo accounts found; the incident starts with 0 affected people');
}

seedIncidents()
  .then(() => console.log('Incident demo seed finished'))
  .catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      console.error(`Invalid seed variables:\n${z.prettifyError(error)}`);
    } else {
      console.error('Incident demo seed failed:', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
