import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { UserModel, type UserRole } from '../models/user.model';
import { hashPassword } from '../utils/password';

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_TI_PASSWORD: z.string().min(8),
  SEED_SOLICITANTE_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  SEED_SOLICITANTE_PASSWORD: z.string().min(8),
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

  await mongoose.connect(env.MONGODB_URI);
  // Make sure the unique email index exists before inserting.
  await UserModel.syncIndexes();

  console.log('Seeding demo users:');
  for (const user of demoUsers) {
    await ensureUser(user);
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
