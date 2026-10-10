import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { TicketModel, TICKET_CATEGORIES, type Ticket, type TicketEvent, type TicketEventType, type TicketPriority } from '../models/ticket.model';
import { UserModel } from '../models/user.model';
import { periodRange } from './manager.service';

type DemoUser = { _id: Types.ObjectId; name: string; role: string };
const PREFIX = '[DEMO GERENCIAL v1]';
export function assertLocalDemoSeed(uri: string, environment: string | undefined, enabled: string | undefined) {
  if (environment === 'production' || enabled !== '1') throw new Error('Seed requires LOCAL_DEMO_SEED=1 and a non-production environment');
  const parsed = new URL(uri);
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/it-helpdesk') throw new Error('Seed is restricted to the local it-helpdesk demonstration database');
}
export function demoTickets(users: DemoUser[], now = new Date(), timezone = 'America/Fortaleza'): (Ticket & { _id: Types.ObjectId })[] {
  const requesters = users.filter(u => u.role === 'solicitante');
  const analysts = users.filter(u => u.role === 'ti');
  const manager = users.find(u => u.role === 'gestor');
  if (requesters.length < 2 || analysts.length < 2 || !manager) throw new Error('Two demo requesters, two demo analysts and one manager are required');
  const start = periodRange('month', now, timezone).start;
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).format(now);
  const elapsed = now.getTime() - start.getTime();
  if (elapsed < 60000) throw new Error('Wait at least one minute after the month starts');
  return Array.from({ length: 24 }, (_, index) => {
    const id = new Types.ObjectId(createHash('sha256').update(`manager-demo-v1:${month}:${index}`).digest('hex').slice(0, 24));
    const availableDays = Math.max(1, Math.floor(elapsed / 86400000));
    const day = index % availableDays;
    const hour = [8, 9, 10, 11, 13, 14, 15, 16][index % 8];
    const candidate = start.getTime() + day * 86400000 + hour * 3600000 + (index % 4) * 900000;
    const createdAt = new Date(Math.min(candidate, now.getTime() - Math.min(3600000, elapsed / 2)));
    const step = Math.min(1800000, (now.getTime() - createdAt.getTime()) / 12);
    const requester = requesters[index % requesters.length];
    let assignee: DemoUser | null = null;
    let status: Ticket['status'] = 'aberto';
    let priority: TicketPriority = ['alta', 'media', 'baixa'][index % 3] as TicketPriority;
    let cycle = 1, revision = 0;
    let resolvedAt: Date | null = null, resolvedBy: Types.ObjectId | null = null;
    const history: TicketEvent[] = [];
    function action(type: TicketEventType, actor: DemoUser, from: Record<string, unknown>, to: Record<string, unknown>, reason?: string) {
      const at = new Date(createdAt.getTime() + history.length * step);
      if (history.length) revision++;
      history.push({ type, author: actor._id, at, message: 'Evento fictício de demonstração gerencial', audit: {
        eventId: randomUUID(), operationId: randomUUID(), schemaVersion: 2, actorId: actor._id, actorSnapshot: { name: actor.name, role: actor.role }, eventType: type, occurredAt: at, revision, eventIndex: 0, cycleId: cycle, from, to, assigneeAtEvent: assignee?._id ?? null, assigneeSnapshot: assignee ? { id: assignee._id.toString(), name: assignee.name, role: assignee.role } : null, reason, dataOrigin: 'demo',
      } });
      return at;
    }
    action('created', requester, {}, { status, priority });
    function assign(actor: DemoUser, target: DemoUser) { const previous = assignee?._id ?? null; assignee = target; action('assigned', actor, { assignee: previous }, { assignee: target._id }, status === 'em_andamento' ? 'Reatribuição fictícia para cobertura de turno' : undefined); }
    function resolve(actor: DemoUser) { status = 'resolvido'; resolvedBy = actor._id; resolvedAt = action('resolved', actor, { status: 'em_andamento' }, { status }, assignee?._id.equals(actor._id) ? undefined : 'Cobertura fictícia de outro analista durante ausência'); }
    if (index % 6 !== 0) {
      const analyst = analysts[index % analysts.length];
      assign(analyst, analyst);
      if (index % 6 !== 1) {
        status = 'em_andamento'; action('status_changed', analyst, { status: 'aberto' }, { status });
        if (index % 4 === 0) assign(manager, analysts[(index + 1) % analysts.length]);
        if (index % 5 === 0) { const previous = priority; priority = 'alta'; action('updated', manager, { priority: previous }, { priority }, 'Reclassificação fictícia por impacto'); }
        if (index % 6 >= 3) {
          resolve(analyst);
          if (index % 6 === 5) {
            cycle++; status = 'em_andamento'; resolvedAt = null; resolvedBy = null;
            action('reopened', manager, { status: 'resolvido' }, { status }, 'Recorrência fictícia após validação');
            assign(manager, analysts[(index + 1) % analysts.length]);
            if (index % 12 === 11) resolve(analysts[(index + 1) % analysts.length]);
          }
        }
      }
    }
    return { _id: id, title: `${PREFIX} ${month} · Caso ${String(index + 1).padStart(2, '0')}`, description: 'Dados inteiramente fictícios, criados para testar o dashboard. Não representam atendimento operacional real.', category: TICKET_CATEGORIES[index % TICKET_CATEGORIES.length], priority, status, requester: requester._id, assignee: assignee ? (assignee as DemoUser)._id : null, history, revision, activeCycleId: cycle, resolvedAt, resolvedBy, dataOrigin: 'demo', createdAt, updatedAt: history.at(-1)!.at! };
  });
}
export async function seedManagerDemo(now = new Date(), timezone = 'America/Fortaleza') {
  // Allowlisted demonstration identities only; no credentials are generated or changed.
  const users = await UserModel.find({ email: { $in: ['ti@helpdesk.local', 'demo.ti2@helpdesk.local', 'solicitante@helpdesk.local', 'demo.solicitante2@helpdesk.local', 'gestor@helpdesk.local'] }, active: { $ne: false } }).select('name role').sort({ _id: 1 }).lean();
  const fixtures = demoTickets(users, now, timezone);
  return insertDemoTickets(fixtures);
}
export async function insertDemoTickets(fixtures: (Ticket & { _id: Types.ObjectId })[]) {
  let created = 0, skipped = 0;
  for (const fixture of fixtures) {
    const existing = await TicketModel.findById(fixture._id).select('title dataOrigin').lean();
    if (existing) {
      if (existing.dataOrigin !== 'demo' || existing.title !== fixture.title) throw new Error('Seed identifier collision; existing record was preserved');
      skipped++; continue;
    }
    try { await new TicketModel(fixture).save({ timestamps: false }); created++; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error;
      const duplicate = await TicketModel.findById(fixture._id).select('title dataOrigin').lean();
      if (!duplicate || duplicate.dataOrigin !== 'demo' || duplicate.title !== fixture.title) throw error;
      skipped++;
    }
  }
  return { created, skipped };
}
