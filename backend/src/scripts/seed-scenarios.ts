import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { UserModel, toPublicUser } from '../models/user.model';
import { createDemoScenarios, type DemoPeople } from '../services/demo-scenarios';

/**
 * Clear, fictitious demo scenarios (see services/demo-scenarios.ts), run after `npm run seed`.
 * Scenarios that need the two extra demo accounts are skipped when those do not exist.
 * Running it again keeps everything that already exists.
 */

const EXTRA_REQUESTER = 'demo.solicitante2@helpdesk.local';
const EXTRA_TECH = 'demo.ti2@helpdesk.local';

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_SOLICITANTE_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
});

async function seedScenarios(): Promise<void> {
  const seedEnv = seedEnvSchema.parse(process.env);
  await mongoose.connect(env.MONGODB_URI);
  const [tech, requester, requester2, tech2] = await Promise.all(
    [seedEnv.SEED_TI_EMAIL, seedEnv.SEED_SOLICITANTE_EMAIL, EXTRA_REQUESTER, EXTRA_TECH].map((email) => UserModel.findOne({ email })),
  );
  if (!tech || !requester) throw new Error('Demo users not found. Run "npm run seed" first.');
  const people: DemoPeople = {
    tech: toPublicUser(tech),
    requester: toPublicUser(requester),
    ...(requester2 && { requester2: toPublicUser(requester2) }),
    ...(tech2 && { tech2: toPublicUser(tech2) }),
  };

  const result = await createDemoScenarios(people);
  for (const title of result.created) console.log(`- ${title}: created`);
  for (const title of result.kept) console.log(`- ${title}: already exists, kept as is`);
  for (const title of result.skipped) console.log(`- ${title}: skipped (needs the extra demo accounts)`);
  console.log(`Scenario demo seed finished: ${result.created.length} created, ${result.kept.length} kept, ${result.skipped.length} skipped`);
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
