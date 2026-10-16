import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { SharedIncidentModel } from '../models/incident.model';
import { TicketModel } from '../models/ticket.model';
import { UserModel } from '../models/user.model';
import { DEMO_EMAILS } from '../services/data-origin';
import { assertLocalDemoSeed } from '../services/manager-demo';

/**
 * Removes specific manual test tickets ("teste", "sdfdsfds"...) from the LOCAL development database.
 * Safe by construction:
 * - only the local it-helpdesk database, outside production, with LOCAL_DEMO_SEED=1;
 * - only the ticket ids given on the command line, never a pattern;
 * - every ticket must be demonstration data created by a reserved fictitious account and must not
 *   be the main ticket of a shared incident; if any id fails a check, nothing is removed;
 * - without --apply it only lists what would be removed; with --apply it first writes a JSON backup
 *   of the full documents to backend/backups/, then removes exactly those ids.
 *
 * Usage (in backend): LOCAL_DEMO_SEED=1 npx tsx src/scripts/remove-dev-test-tickets.ts <id> [<id>...] [--apply]
 */

async function run(): Promise<void> {
  assertLocalDemoSeed(env.MONGODB_URI, process.env.NODE_ENV, process.env.LOCAL_DEMO_SEED);
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ids = args.filter((arg) => arg !== '--apply');
  if (ids.length === 0 || ids.some((id) => !/^[a-f\d]{24}$/i.test(id))) throw new Error('Give one or more ticket ids (24 hex characters)');
  await mongoose.connect(env.MONGODB_URI);

  const tickets = await TicketModel.find({ _id: { $in: ids } }).lean();
  const requesters = new Map((await UserModel.find({ _id: { $in: tickets.map((t) => t.requester) } }).select('email').lean()).map((u) => [String(u._id), u.email]));
  const linked = new Set((await SharedIncidentModel.find({ ticket: { $in: ids } }).select('ticket').lean()).map((i) => String(i.ticket)));

  const problems: string[] = [];
  for (const id of ids) {
    const ticket = tickets.find((t) => String(t._id) === id);
    if (!ticket) { problems.push(`${id}: not found`); continue; }
    const email = requesters.get(String(ticket.requester)) ?? '(removed user)';
    console.log(`- ${id} | ${JSON.stringify(ticket.title)} | origin ${ticket.dataOrigin} | ${ticket.status} | requester ${email}`);
    if (ticket.dataOrigin !== 'demo') problems.push(`${id}: not demonstration data`);
    if (!DEMO_EMAILS.has(email)) problems.push(`${id}: not created by a reserved demo account`);
    if (linked.has(id)) problems.push(`${id}: main ticket of a shared incident`);
  }
  if (problems.length) throw new Error(`Nothing removed:\n${problems.join('\n')}`);
  if (!apply) {
    console.log(`Dry run: ${ids.length} ticket(s) would be removed. Nothing changed. Add --apply to remove them.`);
    return;
  }

  const folder = resolve(__dirname, '../../backups');
  await mkdir(folder, { recursive: true });
  const file = resolve(folder, `removed-test-tickets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(tickets, null, 2));
  const result = await TicketModel.deleteMany({ _id: { $in: ids }, dataOrigin: 'demo' });
  console.log(`Backup written to ${file}. Removed ${result.deletedCount} ticket(s).`);
}

run()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
