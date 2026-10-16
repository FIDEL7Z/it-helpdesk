import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { UserModel } from '../models/user.model';
import { DEMO_ARTICLES, ensureDemoArticles } from '../services/demo-articles';

/** Demonstration help articles (see services/demo-articles.ts), run after `npm run seed`. */

const seedEnvSchema = z.object({
  SEED_TI_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
});

async function seedArticles(): Promise<void> {
  const seedEnv = seedEnvSchema.parse(process.env);
  await mongoose.connect(env.MONGODB_URI);

  const author = await UserModel.findOne({ email: seedEnv.SEED_TI_EMAIL });
  if (!author) throw new Error('Demo IT user not found. Run "npm run seed" first.');

  const results = await ensureDemoArticles(author._id);
  for (const { title, created } of results) console.log(`- ${title}: ${created ? 'created' : 'already exists, kept as is'}`);
  const created = results.filter((result) => result.created).length;
  console.log(`Article demo seed finished: ${created} created, ${DEMO_ARTICLES.length - created} kept`);
}

seedArticles()
  .catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      console.error(`Invalid seed variables:\n${z.prettifyError(error)}`);
    } else {
      console.error('Article demo seed failed:', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
