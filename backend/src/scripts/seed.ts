import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { UserModel, type UserRole } from '../models/user.model';
import { hashPassword } from '../utils/password';

/** An empty value in .env ("SEED_GESTOR_EMAIL=") counts as not set. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const seedEnvSchema = z
  .object({
    SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
    SEED_TI_PASSWORD: z.string().min(8),
    SEED_SOLICITANTE_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
    SEED_SOLICITANTE_PASSWORD: z.string().min(8),
    // Optional so existing .env files keep working: the gestor is created only when both are set.
    SEED_GESTOR_EMAIL: optional(z.string().trim().toLowerCase().pipe(z.email())),
    SEED_GESTOR_PASSWORD: optional(z.string().min(8)),
  })
  .superRefine((seedEnv, ctx) => {
    const hasEmail = seedEnv.SEED_GESTOR_EMAIL !== undefined;
    const hasPassword = seedEnv.SEED_GESTOR_PASSWORD !== undefined;
    if (hasEmail !== hasPassword) {
      ctx.addIssue({
        code: 'custom',
        path: [hasEmail ? 'SEED_GESTOR_PASSWORD' : 'SEED_GESTOR_EMAIL'],
        message: 'Set both SEED_GESTOR_EMAIL and SEED_GESTOR_PASSWORD, or neither',
      });
    }
  });

interface DemoUser {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}

/** Creates the user only if the email is not taken. Never overwrites an existing password. */
async function ensureUser({ name, email, password, role }: DemoUser): Promise<void> {
  const existing = await UserModel.exists({ email });
  if (existing) {
    console.log(`- ${email} (${role}): already exists, skipped`);
    return;
  }

  await UserModel.create({ name, email, role, passwordHash: await hashPassword(password) });
  console.log(`- ${email} (${role}): created`);
}

async function seed(): Promise<void> {
  const seedEnv = seedEnvSchema.parse(process.env);

  const demoUsers: DemoUser[] = [
    {
      name: 'Carlos Andrade',
      email: seedEnv.SEED_TI_EMAIL,
      password: seedEnv.SEED_TI_PASSWORD,
      role: 'ti',
    },
    {
      name: 'Mariana Souza',
      email: seedEnv.SEED_SOLICITANTE_EMAIL,
      password: seedEnv.SEED_SOLICITANTE_PASSWORD,
      role: 'solicitante',
    },
  ];

  if (seedEnv.SEED_GESTOR_EMAIL && seedEnv.SEED_GESTOR_PASSWORD) {
    demoUsers.push({
      name: 'Ana Ribeiro',
      email: seedEnv.SEED_GESTOR_EMAIL,
      password: seedEnv.SEED_GESTOR_PASSWORD,
      role: 'gestor',
    });
  }

  await mongoose.connect(env.MONGODB_URI);
  // Make sure the unique email index exists before inserting.
  await UserModel.syncIndexes();

  console.log('Seeding demo users:');
  for (const user of demoUsers) {
    await ensureUser(user);
  }
  if (!seedEnv.SEED_GESTOR_EMAIL) {
    console.log('- gestor: SEED_GESTOR_EMAIL/SEED_GESTOR_PASSWORD not set, skipped');
  }
}

seed()
  .then(() => console.log('Seed finished'))
  .catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      console.error(`Invalid seed variables:\n${z.prettifyError(error)}`);
    } else {
      console.error('Seed failed:', error);
    }
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
