// Runs the backend on a separate database that holds only fictitious data, so a real AI provider
// can be tried in the browser without sending anything from the development database to it.
// The sandbox database is recreated on every start. Stop the normal backend first: the sandbox
// uses the same port, so the frontend (npm run dev) keeps working unchanged.
// Usage: npm run dev:ai-sandbox            (AI_PROVIDER defaults to gemini here)
//        AI_PROVIDER=demo npm run dev:ai-sandbox

import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { createFictitiousData, FICTITIOUS_ACCOUNTS } from './fictitious-data';

const SANDBOX_DB = 'it-helpdesk-ai-sandbox';

const portIsFree = (port: number) => new Promise<boolean>((resolve) => {
  const probe = createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port);
});

async function main(): Promise<void> {
  const uri = new URL(env.MONGODB_URI);
  if (uri.pathname.replace(/^\//, '') === SANDBOX_DB) throw new Error('MONGODB_URI already points to the sandbox database');
  uri.pathname = `/${SANDBOX_DB}`;
  if (!(await portIsFree(env.PORT))) throw new Error(`Port ${env.PORT} is in use: stop the normal backend first (the sandbox takes its place).`);

  await mongoose.connect(env.MONGODB_URI, { dbName: SANDBOX_DB });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  const seeder = app.listen(0);
  try {
    await createFictitiousData(`http://127.0.0.1:${(seeder.address() as AddressInfo).port}/api`);
  } finally {
    await new Promise((resolve) => seeder.close(resolve));
    await mongoose.disconnect();
  }

  const provider = process.env.AI_PROVIDER || 'gemini';
  console.log(`Sandbox database ${SANDBOX_DB}: fictitious data only (recreated now). AI_PROVIDER=${provider}.`);
  console.log('Sign in at the frontend with:');
  for (const account of Object.values(FICTITIOUS_ACCOUNTS)) console.log(`  ${account.role.padEnd(11)} ${account.email} / ${account.password}`);

  // The real server, watching src and .env like npm run dev, but on the sandbox database. Started
  // with Node directly (no shell), and stopped together with this script.
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, MONGODB_URI: uri.toString(), AI_PROVIDER: provider, EMAIL_ENABLED: 'false' },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'sandbox failed to start');
  process.exitCode = 1;
});
