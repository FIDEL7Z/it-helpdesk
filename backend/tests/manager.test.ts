import { assertLocalDemoSeed, demoTickets, insertDemoTickets } from '../src/services/manager-demo';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';
import { getManagerDashboard, periodRange, type ManagerFilters } from '../src/services/manager.service';

let server: Server;
let url: string;
let requester: Types.ObjectId;
let otherRequester: Types.ObjectId;
let tech: Types.ObjectId;
let otherTech: Types.ObjectId;
let manager: Types.ObjectId;
const now = new Date('2026-06-15T15:00:00Z');
const base: ManagerFilters = { period: 'month', dataOrigin: 'operational' };

async function api(method: string, path: string, actor?: Types.ObjectId, body?: unknown) {
  const response = await fetch(`${url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${signAccessToken(actor.toString())}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
function event(type: string, actor: Types.ObjectId, at: string, cycle = 1, origin = 'operational') {
  const date = new Date(at);
  return { type, author: actor, at: date, message: 'Texto livre não utilizado por indicadores', audit: {
    schemaVersion: 2, eventId: randomUUID(), operationId: randomUUID(), actorId: actor, actorSnapshot: { name: actor.equals(manager) ? 'Gestora' : 'Analista', role: actor.equals(manager) ? 'gestor' : 'ti' },
    eventType: type, occurredAt: date, revision: cycle, eventIndex: 0, cycleId: cycle, assigneeAtEvent: otherTech,
    from: { status: type === 'reopened' ? 'resolvido' : 'em_andamento' }, to: { status: type === 'reopened' ? 'em_andamento' : 'resolvido' }, dataOrigin: origin,
  } };
}
async function fixture(createdAt: string, options: Record<string, unknown> = {}) {
  const result = await TicketModel.collection.insertOne({ title: 'Solicitação de teste', description: 'Descrição válida de teste', category: 'hardware', priority: 'media', status: 'aberto', requester, assignee: null, dataOrigin: 'operational', history: [], revision: 0, activeCycleId: 1, createdAt: new Date(createdAt), updatedAt: new Date(createdAt), ...options });
  return result.insertedId;
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: 'it-helpdesk-test-manager' });
  await mongoose.connection.dropDatabase();
  const users = await UserModel.create([
    { name: 'Solicitante', email: 'requester@manager-test.local', role: 'solicitante', passwordHash: 'unused' },
    { name: 'Outra solicitante', email: 'other@manager-test.local', role: 'solicitante', passwordHash: 'unused' },
    { name: 'Analista A', email: 'a@manager-test.local', role: 'ti', passwordHash: 'unused' },
    { name: 'Analista B', email: 'b@manager-test.local', role: 'ti', passwordHash: 'unused' },
    { name: 'Gestora', email: 'manager@manager-test.local', role: 'gestor', passwordHash: 'unused' },
  ]);
  [requester, otherRequester, tech, otherTech, manager] = users.map(u => u._id);
  await new Promise<void>(resolve => { server = app.listen(0, () => { url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }); });
});
beforeEach(async () => { await TicketModel.deleteMany({}); });
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

describe('Manager analytics and authorization', () => {
  it('allows only authenticated managers, including direct API requests', async () => {
    assert.equal((await api('GET', '/dashboard/manager')).status, 401);
    for (const actor of [requester, tech]) assert.equal((await api('GET', '/dashboard/manager', actor)).status, 403);
    const result = await api('GET', '/dashboard/manager', manager);
    assert.equal(result.status, 200);
    assert.equal(result.body.dashboard.filters.dataOrigin, 'operational');
  });
  it('rejects invalid periods, ids, origins and unknown query fields', async () => {
    for (const query of ['period=all', 'analystId=bad', 'dataOrigin=all', 'scope=all', 'requesterId[$ne]=x']) {
      assert.equal((await api('GET', `/dashboard/manager?${query}`, manager)).status, 400);
    }
  });
  it('uses local calendar boundaries, seven days inclusive of today, and DST zones', () => {
    assert.equal(periodRange('today', now).start.toISOString(), '2026-06-15T03:00:00.000Z');
    assert.equal(periodRange('week', now).start.toISOString(), '2026-06-09T03:00:00.000Z');
    assert.equal(periodRange('month', now).start.toISOString(), '2026-06-01T03:00:00.000Z');
    assert.equal(periodRange('year', now).start.toISOString(), '2026-01-01T03:00:00.000Z');
    assert.equal(periodRange('today', new Date('2026-03-09T15:00:00Z'), 'America/New_York').start.toISOString(), '2026-03-09T04:00:00.000Z');
  });
  it('includes zero-load analysts and separates current backlog from creation periods', async () => {
    await fixture('2025-12-31T12:00:00Z', { assignee: tech, status: 'em_andamento' });
    await fixture('2026-06-14T12:00:00Z');
    const result = await getManagerDashboard(base, now);
    assert.equal(result.current.backlog, 2);
    assert.equal(result.current.unassigned, 1);
    assert.equal(result.period.created, 1);
    assert.equal(result.team.find(u => u.id === otherTech.toString())?.assigned, 0);
    assert.equal(result.team.find(u => u.id === tech.toString())?.inProgress, 1);
  });
  it('ranks requesters by today, week, month and year without counting future or previous-year creations', async () => {
    for (const date of ['2026-06-15T03:00:00Z', '2026-06-09T03:00:00Z', '2026-06-01T03:00:00Z', '2026-01-01T03:00:00Z', '2025-12-31T23:00:00Z', '2026-06-15T16:00:00Z']) await fixture(date);
    await fixture('2026-06-15T04:00:00Z', { requester: otherRequester, category: 'acesso', status: 'resolvido' });
    for (const [period, count] of [['today', 1], ['week', 2], ['month', 3], ['year', 4]] as const) {
      const result = await getManagerDashboard({ ...base, period }, now);
      assert.equal(result.period.created, count + 1);
      const row = result.requesters.find(u => u.id === requester.toString())!;
      assert.equal(row.created, count);
      assert.equal(row.pending, count);
      assert.equal(row.categories[0].category, 'hardware');
    }
  });
  it('counts requests by subject created in the period, not the current backlog', async () => {
    await fixture('2026-06-14T12:00:00Z', { category: 'rede', status: 'resolvido' });
    await fixture('2026-06-13T12:00:00Z', { category: 'rede' });
    await fixture('2026-06-12T12:00:00Z', { category: 'acesso' });
    await fixture('2026-05-20T12:00:00Z', { category: 'software' }); // previous month: outside the period
    const result = await getManagerDashboard(base, now);
    assert.deepEqual(result.demand.categories, [{ _id: 'rede', count: 2 }, { _id: 'acesso', count: 1 }]);
    assert.equal(result.distributions.category.find(row => row._id === 'software')?.count, 1, 'the backlog view still sees it');
  });
  it('uses real creation hour and ISO weekday in the configured timezone', async () => {
    await fixture('2026-06-15T03:10:00Z'); // Monday, 00h Fortaleza.
    await fixture('2026-06-15T02:59:00Z'); // Sunday, 23h Fortaleza.
    const result = await getManagerDashboard(base, now);
    assert.equal(result.demand.hours.length, 24);
    assert.deepEqual(result.demand.hours.filter(row => row.count), [{ _id: 0, count: 1 }, { _id: 23, count: 1 }]);
    assert.equal(result.demand.hours[12].count, 0);
    assert.deepEqual(result.demand.weekdays, [{ _id: 1, count: 1 }, { _id: 7, count: 1 }]);
  });
  it('attributes productivity to the real actor, preserves cycles and deduplicates resolutions', async () => {
    const resolved = event('resolved', tech, '2026-06-10T12:00:00Z');
    await fixture('2026-06-01T12:00:00Z', { assignee: otherTech, status: 'resolvido', history: [resolved, resolved, event('reopened', manager, '2026-06-11T12:00:00Z', 2), event('resolved', tech, '2026-06-12T12:00:00Z', 2)] });
    const result = await getManagerDashboard(base, now);
    assert.equal(result.period.resolutions, 2);
    assert.equal(result.period.resolvedTickets, 1);
    assert.equal(result.team.find(u => u.id === tech.toString())?.resolutions, 2);
    assert.equal(result.team.find(u => u.id === tech.toString())?.participation, 1);
    assert.equal(result.team.find(u => u.id === otherTech.toString())?.resolutions, 0);
    assert.equal(result.team.find(u => u.id === manager.toString())?.reopenings, 1);
    assert.equal(result.trends.reduce((sum, row) => sum + row.resolved, 0), 2);
  });
  it('excludes free-form legacy resolutions, contradictory actors, and mismatching audit identities', async () => {
    await fixture('2026-06-01T12:00:00Z', { status: 'resolvido', assignee: tech, history: [{ type: 'status_changed', message: 'Resolvido por Analista A', author: tech, at: new Date('2026-06-10T12:00:00Z') }] });
    await fixture('2026-06-02T12:00:00Z', { status: 'resolvido', history: [event('resolved', tech, '2026-06-10T12:00:00Z'), event('resolved', otherTech, '2026-06-10T12:00:00Z')] });
    const mismatch = event('resolved', tech, '2026-06-10T12:00:00Z'); mismatch.author = manager;
    await fixture('2026-06-03T12:00:00Z', { status: 'resolvido', history: [mismatch] });
    const result = await getManagerDashboard(base, now);
    assert.equal(result.period.resolutions, 0);
    assert.equal(result.coverage.resolvedWithoutStructuredHistory, 3);
    assert.equal(result.coverage.conflictingResolutionCycles, 1);
  });
  it('separates operational, demonstration and unclassified legacy origins', async () => {
    await fixture('2026-06-01T12:00:00Z');
    await fixture('2026-06-02T12:00:00Z', { dataOrigin: 'demo', status: 'resolvido', history: [event('resolved', tech, '2026-06-10T12:00:00Z', 1, 'demo')] });
    const legacy = await fixture('2026-06-03T12:00:00Z');
    await TicketModel.collection.updateOne({ _id: legacy }, { $unset: { dataOrigin: '' } });
    for (const dataOrigin of ['operational', 'demo', 'legacy'] as const) {
      const result = await getManagerDashboard({ ...base, dataOrigin }, now);
      assert.equal(result.current.total, 1);
      assert.equal(result.period.resolutions, dataOrigin === 'demo' ? 1 : 0);
    }
  });
  it('applies analyst separately to current assignee and historical actor; other filters apply current fields', async () => {
    await fixture('2026-06-01T12:00:00Z', { assignee: otherTech, status: 'resolvido', priority: 'alta', history: [event('resolved', tech, '2026-06-10T12:00:00Z')] });
    const result = await getManagerDashboard({ ...base, analystId: tech.toString(), priority: 'alta', requesterId: requester.toString(), category: 'hardware', status: 'resolvido' }, now);
    assert.equal(result.current.total, 0);
    assert.equal(result.period.resolutions, 1);
    assert.equal(result.team[0].resolutions, 1);
    assert.equal((await getManagerDashboard({ ...base, priority: 'baixa' }, now)).period.resolutions, 0);
  });
  it('preserves metrics and stable references after author deactivation or deletion', async () => {
    const historical = new Types.ObjectId();
    await fixture('2026-06-01T12:00:00Z', { status: 'resolvido', history: [event('resolved', historical, '2026-06-10T12:00:00Z')] });
    const result = await getManagerDashboard(base, now);
    const row = result.team.find(u => u.id === historical.toString())!;
    assert.equal(row.resolutions, 1);
    assert.equal(row.name, 'Analista');
    assert.equal(row.active, false);
  });
  it('keeps authorization when drilling down by assignee or requester', async () => {
    await fixture('2026-06-01T12:00:00Z', { assignee: otherTech });
    await fixture('2026-06-01T12:00:00Z', { status: 'resolvido' });
    assert.equal((await api('GET', '/tickets?pending=true', manager)).body.pagination.total, 1);
    assert.equal((await api('GET', '/tickets?pending=true&status=resolvido', manager)).body.pagination.total, 0);
    assert.equal((await api('GET', `/tickets?assigneeId=${otherTech}`, manager)).body.pagination.total, 1);
    assert.equal((await api('GET', `/tickets?requesterId=${otherRequester}`, requester)).status, 403);
    assert.equal((await api('GET', `/tickets?assigneeId=${tech}`, requester)).status, 403);
  });
  it('reproduces cross-assignee resolution through the API and uses authenticated actor in manager metrics', async () => {
    const created = await api('POST', '/tickets', requester, { title: 'Reprodução real', description: 'Analista resolve chamado de outro', category: 'rede', priority: 'alta' });
    const id = created.body.ticket.id;
    let ticket = (await api('PATCH', `/tickets/${id}/assignee`, manager, { assigneeId: otherTech.toString(), expectedRevision: 0 })).body.ticket;
    ticket = (await api('PATCH', `/tickets/${id}/status`, manager, { status: 'em_andamento', expectedRevision: ticket.revision })).body.ticket;
    const denied = await api('PATCH', `/tickets/${id}/status`, tech, { status: 'resolvido', expectedRevision: ticket.revision });
    assert.equal(denied.status, 400);
    const done = await api('PATCH', `/tickets/${id}/status`, tech, { status: 'resolvido', expectedRevision: ticket.revision, reason: 'Cobertura de atendimento da equipe' });
    assert.equal(done.status, 200);
    assert.equal(done.body.ticket.resolvedById, tech.toString());
    assert.equal(done.body.ticket.assigneeId, otherTech.toString());
    const result = await getManagerDashboard(base, new Date(Date.now() + 1000));
    assert.equal(result.team.find(u => u.id === tech.toString())?.resolutions, 1);
    assert.equal(result.team.find(u => u.id === otherTech.toString())?.resolutions, 0);
  });
});

describe('Actionable alerts', () => {
  it('distinguishes age, proved inactivity and unknown activity without relying on updatedAt', async () => {
    await fixture('2026-06-01T12:00:00Z', { priority: 'alta', updatedAt: now });
    await fixture('2026-06-02T12:00:00Z', { assignee: tech, priority: 'alta', status: 'em_andamento', history: [event('assigned', tech, '2026-06-03T12:00:00Z')], updatedAt: now });
    await fixture('2026-06-03T12:00:00Z', { assignee: otherTech, history: [event('assigned', otherTech, '2026-06-15T12:00:00Z')] });
    const result = await getManagerDashboard(base, now);
    assert.equal(result.alerts.highUnassigned, 1);
    assert.equal(result.alerts.oldPending, 3);
    assert.equal(result.alerts.inactive, 1);
    assert.equal(result.alerts.unknownActivity, 1);
    assert.equal(result.alerts.oldest[0].ageDays, 14);
    assert.equal(result.alerts.oldest[0].lastOperationalAt, null);
    assert.equal(result.team.find(row => row.id === tech.toString())!.highPriority, 1);
    assert.equal(result.workload.reduce((sum, row) => sum + row.alta + row.media + row.baixa, 0), result.current.backlog);
    assert.equal((await getManagerDashboard({ ...base, inactivityDays: 14 }, now)).alerts.inactive, 0);
  });
  it('links to exactly the matching high priority, old and inactive queue', async () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    await fixture(old, { priority: 'alta' });
    await fixture(old, { assignee: tech, history: [event('assigned', tech, old)] });
    const result = await getManagerDashboard(base);
    for (const [attention, count] of [['high_unassigned', result.alerts.highUnassigned], ['oldest', result.alerts.oldPending], ['inactive', result.alerts.inactive]]) {
      const response = await api('GET', `/tickets?dataOrigin=operational&attention=${attention}&ageDays=7&inactivityDays=3`, manager);
      assert.equal(response.status, 200); assert.equal(response.body.pagination.total, count);
    }
  });
  it('disables demo indicators without explicit configuration', async () => {
    const before = env.DEMO_MODE;
    try { env.DEMO_MODE = false; assert.equal((await api('GET', '/dashboard/manager?dataOrigin=demo', manager)).status, 403); }
    finally { env.DEMO_MODE = before; }
  });
});

describe('Local structured demonstration fixtures', () => {
  it('refuses production, remote hosts and missing opt-in', () => {
    assert.doesNotThrow(() => assertLocalDemoSeed('mongodb://127.0.0.1:27017/it-helpdesk', 'development', '1'));
    for (const [uri, environment, enabled] of [['mongodb://127.0.0.1/it-helpdesk', 'production', '1'], ['mongodb://remote/it-helpdesk', 'development', '1'], ['mongodb://127.0.0.1/real-data', 'development', '1'], ['mongodb://127.0.0.1/it-helpdesk', 'development', undefined]]) assert.throws(() => assertLocalDemoSeed(uri!, environment, enabled));
  });
  it('creates coherent fictitious cycles idempotently without rewriting existing tickets', async () => {
    const existing = await fixture('2026-06-01T12:00:00Z');
    const before = await TicketModel.findById(existing).lean();
    const users = await UserModel.find().select('name role').lean();
    const fixtures = demoTickets(users, now);
    for (const fixture of fixtures) {
      assert.equal(fixture.dataOrigin, 'demo');
      assert.equal(fixture.history.at(-1)!.audit!.revision, fixture.revision);
      assert.equal(fixture.history.at(-1)!.audit!.cycleId, fixture.activeCycleId);
      assert.ok(fixture.createdAt >= periodRange('month', now).start);
      for (let i = 0; i < fixture.history.length; i++) {
        assert.equal(fixture.history[i].audit!.revision, i);
        assert.ok(fixture.history[i].at! <= now);
        if (i) assert.ok(fixture.history[i].at! > fixture.history[i - 1].at!);
      }
      if (fixture.status === 'resolvido') { assert.equal(fixture.history.at(-1)!.type, 'resolved'); assert.ok(fixture.resolvedBy!.equals(fixture.history.at(-1)!.author!)); }
      else { assert.equal(fixture.resolvedAt, null); assert.equal(fixture.resolvedBy, null); }
    }
    assert.deepEqual(await insertDemoTickets(fixtures), { created: 24, skipped: 0 });
    const stored = await TicketModel.find({ dataOrigin: 'demo' }).sort({ _id: 1 }).lean();
    assert.deepEqual(await insertDemoTickets(demoTickets(users, new Date(now.getTime() + 60000))), { created: 0, skipped: 24 });
    assert.deepEqual(await TicketModel.find({ dataOrigin: 'demo' }).sort({ _id: 1 }).lean(), stored);
    assert.deepEqual(await TicketModel.findById(existing).lean(), before);
    const demo = await getManagerDashboard({ ...base, dataOrigin: 'demo' }, now);
    assert.equal(demo.current.total, 24); assert.ok(demo.period.resolutions > 10); assert.equal(demo.coverage.resolvedWithoutStructuredHistory, 0); assert.equal(demo.coverage.conflictingResolutionCycles, 0); assert.ok(demo.period.reopenings > 0);
    assert.equal((await getManagerDashboard(base, now)).current.total, 1);
  });
});

describe('Creation interval drill-down', () => {
  it('keeps period boundaries and requester authorization on list links', async () => {
    await fixture('2026-06-01T03:00:00Z');
    await fixture('2026-05-31T23:00:00Z');
    await fixture('2026-06-15T15:00:00Z');
    const result = await api('GET', `/tickets?createdFrom=2026-06-01T03:00:00.000Z&createdTo=2026-06-15T15:00:00.000Z&requesterId=${requester}`, manager);
    assert.equal(result.status, 200); assert.equal(result.body.pagination.total, 1);
    assert.equal((await api('GET', `/tickets?requesterId=${otherRequester}&createdFrom=2026-06-01T03:00:00.000Z`, requester)).status, 403);
    assert.equal((await api('GET', '/tickets?createdFrom=bad', manager)).status, 400);
  });
});
