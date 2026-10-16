import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { UserModel, toPublicUser } from '../models/user.model';
import { seedDemoInventory } from '../services/demo-inventory';

/**
 * Demonstration stock and assets (see services/demo-inventory.ts), run after `npm run seed` and,
 * preferably, `npm run seed:scenarios`. Refused in production. Running it again changes nothing.
 */

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_SOLICITANTE_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_GESTOR_EMAIL: z.string().trim().toLowerCase().pipe(z.email()).optional(),
});

async function seedInventory(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('The demonstration inventory is never seeded in production');
  const seedEnv = seedEnvSchema.parse(process.env);
  await mongoose.connect(env.MONGODB_URI);
  const emails = [seedEnv.SEED_TI_EMAIL, seedEnv.SEED_SOLICITANTE_EMAIL, seedEnv.SEED_GESTOR_EMAIL ?? 'gestor@helpdesk.local', 'demo.solicitante2@helpdesk.local', 'demo.ti2@helpdesk.local'];
  const [tech, requester, manager, requester2, tech2] = await Promise.all(emails.map((email) => UserModel.findOne({ email })));
  if (!tech || !requester) throw new Error('Demo users not found. Run "npm run seed" first.');
  const log = await seedDemoInventory({
    tech: toPublicUser(tech), requester: toPublicUser(requester),
    ...(manager && { manager: toPublicUser(manager) }), ...(requester2 && { requester2: toPublicUser(requester2) }), ...(tech2 && { tech2: toPublicUser(tech2) }),
  });
  for (const line of log) console.log(`- ${line}`);
  console.log(`Inventory demo seed finished (${log.length} change(s); a second run changes nothing).`);
}

seedInventory()
  .catch((error: unknown) => {
    if (error instanceof z.ZodError) console.error(`Invalid seed variables:\n${z.prettifyError(error)}`);
    else console.error('Inventory demo seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
