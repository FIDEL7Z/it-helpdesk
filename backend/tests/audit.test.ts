import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

const database = 'it-helpdesk-test-audit';
let server: Server;
let base: string;
type Actor = { id: string; token: string };
let requester: Actor, analyst: Actor, other: Actor, manager: Actor;
async function user(name: string, role: UserRole, email = `${name}@audit.local`): Promise<Actor> {
  const record = await UserModel.create({ name, email, role, passwordHash: 'unused' });
  return { id: record.id, token: signAccessToken(record.id) };
}
async function request(actor: Actor, method: string, path: string, body?: object) {
  const response = await fetch(base + path, { method,
    headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function create(actor = requester) {
  const result = await request(actor, 'POST', '/tickets', {
    title: 'Caso de rastreabilidade', description: 'Descrição fictícia para teste de integridade.', category: 'software',
  });
  assert.equal(result.status, 201);
  return result.body.ticket;
}
async function mutate(actor: Actor, id: string, suffix: string, input: object) {
  const read = await request(actor, 'GET', `/tickets/${id}`);
  return request(actor, 'PATCH', `/tickets/${id}${suffix}`, { expectedRevision: read.body.ticket.revision, ...input });
}
before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: database });
  await mongoose.connection.dropDatabase();
  requester = await user('requester', 'solicitante');
  analyst = await user('analyst', 'ti');
  other = await user('other', 'ti');
  manager = await user('manager', 'gestor');
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
beforeEach(async () => { await TicketModel.deleteMany({}); });
after(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('structured ticket audit', () => {
  it('requires justification for A resolving B, persists A and B separately and projects the resolution', async () => {
    const ticket = await create();
    assert.equal((await mutate(analyst, ticket.id, '/assignee', { assigneeId: other.id })).status, 200);
    assert.equal((await mutate(analyst, ticket.id, '/status', { status: 'em_andamento' })).status, 200);
    const before = await TicketModel.findById(ticket.id).lean();
    assert.equal((await mutate(analyst, ticket.id, '/status', { status: 'resolvido' })).status, 400);
    assert.deepEqual(await TicketModel.findById(ticket.id).lean(), before);
    const result = await mutate(analyst, ticket.id, '/status', { status: 'resolvido', reason: 'Concluí a correção em colaboração com o responsável.' });
    assert.equal(result.status, 200);
    const event = result.body.ticket.history.at(-1);
    assert.equal(result.body.ticket.requester.id, requester.id);
    assert.equal(result.body.ticket.assignee.id, other.id);
    assert.equal(result.body.ticket.resolvedBy.id, analyst.id);
    assert.equal(event.audit.actorId, analyst.id);
    assert.equal(event.audit.assigneeAtEvent, other.id);
    assert.deepEqual(event.audit.from, { status: 'em_andamento' });
    assert.deepEqual(event.audit.to, { status: 'resolvido' });
    assert.equal(event.audit.revision, 3);
    assert.equal(event.at, result.body.ticket.resolvedAt);
    assert.equal(event.audit.occurredAt, event.at);
    assert.equal(event.type, 'resolved');
    const persisted = await TicketModel.findById(ticket.id).lean();
    assert.equal(String(persisted!.history.at(-1)!.audit!.actorId), analyst.id);
    assert.equal(String(persisted!.resolvedBy), analyst.id);
  });

  it('manager assumes, resolves, reopens into a new cycle and preserves both resolutions', async () => {
    const ticket = await create();
    const start = await mutate(manager, ticket.id, '/status', { status: 'em_andamento' });
    assert.equal(start.status, 200);
    assert.equal(start.body.ticket.assignee.id, manager.id);
    assert.equal((await mutate(manager, ticket.id, '/status', { status: 'resolvido' })).status, 200);
    assert.equal((await mutate(manager, ticket.id, '/status', { status: 'em_andamento' })).status, 400);
    const reopened = await mutate(manager, ticket.id, '/status', { status: 'em_andamento', reason: 'Problema voltou a ocorrer após validação.' });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.ticket.activeCycleId, 2);
    assert.equal(reopened.body.ticket.resolvedAt, null);
    assert.equal(reopened.body.ticket.resolvedBy, null);
    const resolved = await mutate(other, ticket.id, '/status', { status: 'resolvido', reason: 'Realizei o atendimento deste segundo ciclo.' });
    const events = resolved.body.ticket.history.filter((e: any) => e.type === 'resolved');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e: any) => [e.audit.cycleId, e.audit.actorId]), [[1, manager.id], [2, other.id]]);
    assert.equal(resolved.body.ticket.resolvedBy.id, other.id);
  });

  it('rejects missing, stale and spoofed mutation metadata without changing history', async () => {
    const ticket = await create();
    assert.equal((await request(analyst, 'PATCH', `/tickets/${ticket.id}/status`, { status: 'em_andamento' })).status, 400);
    assert.equal((await request(analyst, 'PATCH', `/tickets/${ticket.id}/status`, { status: 'em_andamento', expectedRevision: 0, actorId: other.id })).status, 400);
    await mutate(analyst, ticket.id, '', { category: 'rede' });
    const before = await TicketModel.findById(ticket.id).lean();
    assert.equal((await request(analyst, 'PATCH', `/tickets/${ticket.id}`, { expectedRevision: 0, category: 'hardware' })).status, 409);
    assert.deepEqual(await TicketModel.findById(ticket.id).lean(), before);
  });

  it('allows only one concurrent write at the exact same revision', async () => {
    const ticket = await create();
    const results = await Promise.all(['rede', 'hardware'].map(category => request(analyst, 'PATCH', `/tickets/${ticket.id}`, { category, expectedRevision: 0 })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const record = await TicketModel.findById(ticket.id);
    assert.equal(record!.revision, 1);
    assert.equal(record!.history.length, 2);
  });

  it('does not record state, revision or history when the atomic write fails', async context => {
    const ticket = await create();
    const before = await TicketModel.findById(ticket.id).lean();
    const failure = context.mock.method(TicketModel, 'findOneAndUpdate', () => {
      throw new Error('Injected isolated audit write failure');
    });
    try {
      assert.equal((await request(analyst, 'PATCH', `/tickets/${ticket.id}`, { category: 'rede', expectedRevision: 0 })).status, 500);
      assert.deepEqual(await TicketModel.findById(ticket.id).lean(), before);
    } finally {
      failure.mock.restore();
    }
  });

  it('preserves raw legacy events and initializes revision without inventing resolution evidence', async () => {
    const id = new mongoose.Types.ObjectId();
    const at = new Date('2020-01-01');
    const history = [{ type: 'created', author: new mongoose.Types.ObjectId(requester.id), at, message: 'Evento original' }];
    await TicketModel.collection.insertOne({ _id: id, title: 'Chamado legado', description: 'Descrição antiga preservada.', category: 'software', priority: 'media', status: 'aberto', requester: new mongoose.Types.ObjectId(requester.id), assignee: null, history, createdAt: at, updatedAt: at });
    const result = await mutate(analyst, String(id), '', { category: 'rede' });
    assert.equal(result.status, 200);
    const raw = await TicketModel.collection.findOne({ _id: id });
    assert.deepEqual(raw!.history[0], history[0]);
    assert.equal(result.body.ticket.history[0].audit, undefined);
    assert.equal(result.body.ticket.revision, 1);
    assert.equal(result.body.ticket.resolvedBy, null);
    assert.equal(result.body.ticket.dataOrigin, 'legacy');
  });

  it('blocks resolving without an assignee and refuses future-dated state', async () => {
    const ticket = await create();
    await TicketModel.updateOne({ _id: ticket.id }, { status: 'em_andamento' });
    assert.equal((await mutate(analyst, ticket.id, '/status', { status: 'resolvido', reason: 'Tentativa sem responsável.' })).status, 409);
    await TicketModel.updateOne({ _id: ticket.id }, { updatedAt: new Date(Date.now() + 86400000) }, { timestamps: false });
    assert.equal((await mutate(analyst, ticket.id, '', { category: 'rede' })).status, 409);
  });

  it('returns unknown legacy authors and dates without manufacturing them on read or write', async () => {
    const id = new mongoose.Types.ObjectId();
    const history = [{ type: 'created', message: 'Registro incompleto preservado' }];
    await TicketModel.collection.insertOne({ _id: id, title: 'Legado incompleto', description: 'Sem evidência de autoria ou datas.', category: 'rede', priority: 'media', status: 'aberto', requester: new mongoose.Types.ObjectId(requester.id), assignee: null, history });
    const read = await request(analyst, 'GET', `/tickets/${id}`);
    assert.equal(read.body.ticket.history[0].authorId, null);
    assert.equal(read.body.ticket.history[0].at, null);
    assert.equal(read.body.ticket.createdAt, null);
    assert.equal(read.body.ticket.updatedAt, null);
    assert.equal((await mutate(analyst, String(id), '', { category: 'software' })).status, 200);
    const raw = await TicketModel.collection.findOne({ _id: id });
    assert.deepEqual(raw!.history[0], history[0]);
    assert.equal(raw!.createdAt, undefined);
  });

  it('validates actor, type and date consistency of structured events', async () => {
    const ticket = await create();
    const record = await TicketModel.findById(ticket.id);
    record!.history[0].audit!.actorId = new mongoose.Types.ObjectId(other.id);
    await assert.rejects(record!.validate(), /Actor must match/);
    record!.history[0].audit!.actorId = new mongoose.Types.ObjectId(requester.id);
    record!.history[0].audit!.occurredAt = new Date(Date.now() + 86400000);
    await assert.rejects(record!.validate(), /Audit date/);
    record!.history[0].audit!.occurredAt = record!.history[0].at!;
    record!.history[0].audit!.eventType = 'resolved';
    await assert.rejects(record!.validate(), /Event types must agree/);
  });

  it('blocks disabled actors and assignees while retaining old audit references', async () => {
    const disabled = await user('disabled', 'ti');
    const ticket = await create();
    await UserModel.updateOne({ _id: disabled.id }, { active: false });
    assert.equal((await request(disabled, 'GET', '/tickets')).status, 401);
    assert.equal((await mutate(analyst, ticket.id, '/assignee', { assigneeId: disabled.id })).status, 400);
    const staff = await request(manager, 'GET', '/users/it-staff');
    assert.ok(!staff.body.users.some((u: any) => u.id === disabled.id));
  });

  it('keeps actor snapshots and IDs after rename and deletion', async () => {
    const temporary = await user('temporary', 'ti');
    const ticket = await create();
    await mutate(temporary, ticket.id, '/status', { status: 'em_andamento' });
    await UserModel.updateOne({ _id: temporary.id }, { name: 'Renamed operator' });
    await UserModel.deleteOne({ _id: temporary.id });
    const detail = (await request(manager, 'GET', `/tickets/${ticket.id}`)).body.ticket;
    const event = detail.history[1];
    assert.equal(event.author, null);
    assert.equal(event.authorId, temporary.id);
    assert.equal(event.audit.actorSnapshot.name, 'temporary');
    assert.equal(detail.assigneeId, temporary.id);
    assert.equal(detail.history.at(-1).audit.assigneeSnapshot.name, 'temporary');
  });

  it('separates demonstration and unclassified legacy data from operational indicators', async () => {
    await create();
    const demo = await user('demo', 'solicitante', 'demo.solicitante2@helpdesk.local');
    // The requester response does not carry dataOrigin; the classification is checked where it is stored.
    assert.equal((await TicketModel.findById((await create(demo)).id))?.dataOrigin, 'demo');
    await TicketModel.create({ title: 'Legado desconhecido', description: 'Origem sem comprovação.', category: 'rede', requester: requester.id });
    const demoMode = env.DEMO_MODE;
    try {
      // Demonstration mode: each origin is consulted on its own.
      env.DEMO_MODE = true;
      for (const dataOrigin of ['operational', 'demo', 'legacy']) {
        const summary = await request(manager, 'GET', `/dashboard/summary?dataOrigin=${dataOrigin}`);
        assert.equal(summary.body.summary.byStatus.total, 1);
        const listing = await request(manager, 'GET', `/tickets?dataOrigin=${dataOrigin}`);
        assert.equal(listing.body.pagination.total, 1);
      }
      // Normal mode: only operational data, whatever the client asks for.
      env.DEMO_MODE = false;
      for (const dataOrigin of ['demo', 'legacy']) {
        assert.equal((await request(manager, 'GET', `/dashboard/summary?dataOrigin=${dataOrigin}`)).status, 403);
        assert.equal((await request(manager, 'GET', `/tickets?dataOrigin=${dataOrigin}`)).status, 403);
      }
      assert.equal((await request(manager, 'GET', '/dashboard/summary')).body.summary.byStatus.total, 1);
      assert.equal((await request(manager, 'GET', '/tickets')).body.pagination.total, 1);
    } finally {
      env.DEMO_MODE = demoMode;
    }
  });

  it('requires reasons for priority changes and reassignments during work', async () => {
    const ticket = await create();
    assert.equal((await mutate(analyst, ticket.id, '', { priority: 'alta' })).status, 400);
    assert.equal((await mutate(analyst, ticket.id, '', { priority: 'alta', reason: 'Serviço essencial indisponível.' })).status, 200);
    await mutate(analyst, ticket.id, '/status', { status: 'em_andamento' });
    assert.equal((await mutate(manager, ticket.id, '/assignee', { assigneeId: other.id })).status, 400);
    assert.equal((await mutate(manager, ticket.id, '/assignee', { assigneeId: other.id, reason: 'Transferência por disponibilidade da equipe.' })).status, 200);
  });
});
