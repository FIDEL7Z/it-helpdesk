import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// "Seu problema foi resolvido?": the requester confirms, contests or rates a resolution.
const TEST_DB_NAME = 'it-helpdesk-test-resolution';

let server: Server;
let baseUrl: string;

interface TestUser { id: string; token: string }
let requester: TestUser;
let otherRequester: TestUser;
let tech: TestUser;
let otherTech: TestUser;
let manager: TestUser;

type Json = { [key: string]: any };

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json, raw };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@resolution.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

const revisionOf = async (id: string) => (await api('GET', `/tickets/${id}`, tech)).body.ticket.revision;

async function status(id: string, user: TestUser, next: string, reason?: string): Promise<Json> {
  const result = await api('PATCH', `/tickets/${id}/status`, user, { status: next, expectedRevision: await revisionOf(id), ...(reason && { reason }) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.ticket;
}

/** A ticket of `requester`, started and resolved by `resolver` (its assignee). */
async function resolvedTicket(resolver: TestUser = tech): Promise<Json> {
  const created = await api('POST', '/tickets', requester, { title: 'Notebook reiniciando sozinho', description: 'O notebook reinicia sozinho várias vezes ao dia.', category: 'hardware' });
  assert.equal(created.status, 201);
  await status(created.body.ticket.id, resolver, 'em_andamento');
  return status(created.body.ticket.id, resolver, 'resolvido');
}

const confirm = (id: string, cycleId: number, user = requester) => api('POST', `/tickets/${id}/resolution/confirm`, user, { cycleId });
const contest = (id: string, cycleId: number, reason: string | undefined, user = requester) =>
  api('POST', `/tickets/${id}/resolution/contest`, user, { cycleId, ...(reason !== undefined && { reason }) });
const rate = (id: string, body: Json, user = requester) => api('POST', `/tickets/${id}/resolution/rating`, user, body);
const stored = (id: string) => TicketModel.findById(id).lean();

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);
  requester = await createUser('Sara Pedido', 'solicitante');
  otherRequester = await createUser('Caio Pedido', 'solicitante');
  tech = await createUser('Tom Suporte', 'ti');
  otherTech = await createUser('Lia Suporte', 'ti');
  manager = await createUser('Mara Gestora', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('who can answer', () => {
  it('only the requester; the team cannot answer for them and nobody gets a general status permission', async () => {
    const ticket = await resolvedTicket();
    assert.equal((await confirm(ticket.id, 1, otherRequester)).status, 404, 'another requester does not even see it');
    assert.equal((await confirm(ticket.id, 1, tech)).status, 403);
    assert.equal((await confirm(ticket.id, 1, manager)).status, 403);
    assert.equal((await contest(ticket.id, 1, 'Continua igual.', tech)).status, 403);
    const forged = await api('PATCH', `/tickets/${ticket.id}/status`, requester, { status: 'em_andamento', expectedRevision: ticket.revision, reason: 'Quero reabrir.' });
    assert.equal(forged.status, 403, 'requesters still cannot change status directly');
  });

  it('validates the body: cycle, reason, rating and comment; the user comes from the token', async () => {
    const ticket = await resolvedTicket();
    assert.equal((await api('POST', `/tickets/${ticket.id}/resolution/confirm`, requester, {})).status, 400);
    assert.equal((await api('POST', `/tickets/${ticket.id}/resolution/confirm`, requester, { cycleId: 1, userId: otherRequester.id })).status, 400);
    assert.equal((await contest(ticket.id, 1, undefined)).status, 400, 'reason is required');
    assert.equal((await contest(ticket.id, 1, 'não')).status, 400, 'reason too short');
    assert.equal((await stored(ticket.id))?.status, 'resolvido', 'nothing changed');
  });
});

describe('confirming', () => {
  it('records the requester, the server date and the cycle; the resolution and its author are kept', async () => {
    const ticket = await resolvedTicket();
    const before = Date.now();
    const result = await confirm(ticket.id, 1);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.ticket.resolutionFeedback, { cycleId: 1, status: 'confirmed', rating: null, comment: null });
    assert.equal(result.body.ticket.status, 'resolvido');
    assert.equal('audit' in result.body.ticket.history.at(-1), false, 'requester view stays without audit metadata');

    const doc = (await stored(ticket.id))!;
    const event = doc.history.at(-1)!;
    assert.equal(event.type, 'resolution_confirmed');
    assert.equal(event.audit!.actorId.toString(), requester.id);
    assert.equal(event.audit!.cycleId, 1);
    assert.ok(event.audit!.occurredAt.getTime() >= before - 1000);
    assert.equal(doc.resolvedBy?.toString(), tech.id);
    assert.ok(doc.history.some((item) => item.type === 'resolved' && item.audit?.actorId.toString() === tech.id));
  });

  it('repeated and simultaneous confirmations record a single event', async () => {
    const ticket = await resolvedTicket();
    const results = await Promise.all([1, 2, 3].map(() => confirm(ticket.id, 1)));
    assert.ok(results.every((result) => [200, 409].includes(result.status)));
    assert.equal((await confirm(ticket.id, 1)).status, 200, 'confirming again is harmless');
    assert.equal((await stored(ticket.id))!.history.filter((item) => item.type === 'resolution_confirmed').length, 1);
  });

  it('the requester list shows what still waits for their answer', async () => {
    const ticket = await resolvedTicket();
    const listed = async () => (await api('GET', '/tickets?limit=50', requester)).body.tickets.find((item: Json) => item.id === ticket.id);
    assert.equal((await listed()).awaitingConfirmation, true);
    await confirm(ticket.id, 1);
    assert.equal((await listed()).awaitingConfirmation, false);
  });
});

describe('rating (optional)', () => {
  it('only after confirming, once per resolution, 1 to 5 with an optional comment', async () => {
    const ticket = await resolvedTicket();
    assert.equal((await rate(ticket.id, { cycleId: 1, rating: 5 })).status, 409, 'confirm first');
    await confirm(ticket.id, 1);
    for (const invalid of [{ cycleId: 1, rating: 0 }, { cycleId: 1, rating: 6 }, { cycleId: 1, rating: 4.5 }, { cycleId: 1, rating: 4, comment: 'x'.repeat(501) }]) {
      assert.equal((await rate(ticket.id, invalid)).status, 400, JSON.stringify(invalid).slice(0, 60));
    }
    const rated = await rate(ticket.id, { cycleId: 1, rating: 4, comment: 'Atendimento rápido.' });
    assert.equal(rated.status, 200);
    assert.deepEqual(rated.body.ticket.resolutionFeedback, { cycleId: 1, status: 'confirmed', rating: 4, comment: 'Atendimento rápido.' });
    assert.equal((await rate(ticket.id, { cycleId: 1, rating: 1 })).status, 409, 'one rating per resolution');
    assert.equal((await rate(ticket.id, { cycleId: 1, rating: 2 }, tech)).status, 403);

    const team = await api('GET', `/tickets/${ticket.id}`, manager);
    assert.equal(team.body.ticket.resolutionFeedback.rating, 4);
    assert.equal(team.body.ticket.history.at(-1).audit.to.comment, 'Atendimento rápido.');
  });
});

describe('contesting', () => {
  it('requires a reason, reopens into a new cycle and keeps the previous resolution and its author', async () => {
    const ticket = await resolvedTicket();
    const result = await contest(ticket.id, 1, 'Reiniciou de novo hoje de manhã.');
    assert.equal(result.status, 200);
    assert.equal(result.body.ticket.status, 'em_andamento');
    assert.deepEqual(result.body.ticket.resolutionFeedback, { cycleId: 1, status: 'contested', rating: null, comment: null });

    const doc = (await stored(ticket.id))!;
    assert.equal(doc.activeCycleId, 2);
    assert.equal(doc.resolvedBy, null);
    const resolved = doc.history.find((item) => item.type === 'resolved')!;
    assert.equal(resolved.audit!.actorId.toString(), tech.id, 'the earlier resolution keeps its author');
    const reopened = doc.history.at(-1)!;
    assert.equal(reopened.type, 'reopened');
    assert.equal(reopened.audit!.actorId.toString(), requester.id);
    assert.equal(reopened.audit!.reason, 'Reiniciou de novo hoje de manhã.');
    assert.equal(reopened.audit!.cycleId, 2);
    assert.equal(reopened.audit!.to.contestedCycle, 1);

    const queue = (await api('GET', '/tickets?status=em_andamento&limit=50', tech)).body.tickets.find((item: Json) => item.id === ticket.id);
    assert.equal(queue.contested, true, 'the team queue shows the reopening by the requester');
    assert.equal((await contest(ticket.id, 1, 'Ainda continua.')).status, 409, 'a repeated request does not reopen twice');
  });

  it('simultaneous contests reopen only once', async () => {
    const ticket = await resolvedTicket();
    const results = await Promise.all([1, 2, 3].map(() => contest(ticket.id, 1, 'O problema voltou.')));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.ok(results.every((result) => [200, 409].includes(result.status)));
    const doc = (await stored(ticket.id))!;
    assert.equal(doc.activeCycleId, 2);
    assert.equal(doc.history.filter((item) => item.type === 'reopened').length, 1);
  });

  it('cannot contest a confirmed resolution, an old cycle, or after the team already reopened', async () => {
    const confirmed = await resolvedTicket();
    await confirm(confirmed.id, 1);
    assert.equal((await contest(confirmed.id, 1, 'Mudei de ideia.')).status, 409);

    const reopenedByTeam = await resolvedTicket();
    await status(reopenedByTeam.id, tech, 'em_andamento', 'Monitoramento detectou nova falha.');
    assert.equal((await confirm(reopenedByTeam.id, 1)).status, 409, 'the team reopened before the requester answered');
    assert.equal((await contest(reopenedByTeam.id, 1, 'Continua.')).status, 409);

    const twoCycles = await resolvedTicket();
    await contest(twoCycles.id, 1, 'Ainda reinicia.');
    await status(twoCycles.id, tech, 'resolvido');
    assert.equal((await confirm(twoCycles.id, 1)).status, 409, 'old cycle');
    assert.equal((await confirm(twoCycles.id, 2)).status, 200, 'current cycle');
  });
});

describe('quality indicators for the manager', () => {
  it('measures answers to the resolutions of the period, without treating no answer as a bad one', async () => {
    await TicketModel.deleteMany({});
    const first = await resolvedTicket();
    await confirm(first.id, 1);
    await rate(first.id, { cycleId: 1, rating: 5 });
    const second = await resolvedTicket();
    await confirm(second.id, 1);
    await rate(second.id, { cycleId: 1, rating: 3 });
    const third = await resolvedTicket();
    await contest(third.id, 1, 'Ainda está com defeito.');
    await resolvedTicket(otherTech);

    const { status: code, body } = await api('GET', '/dashboard/manager?period=month&dataOrigin=operational', manager);
    assert.equal(code, 200);
    assert.deepEqual(body.dashboard.quality, {
      resolutions: 4, confirmed: 2, contested: 1, awaiting: 1, responseRate: 0.75, ratings: 2, averageRating: 4,
    });
    assert.equal(body.dashboard.period.reopenings, 0, 'a contest is not counted as an operator reopening');

    // Filtering by analyst means "resolutions this person performed", never the current assignee.
    const byAnalyst = await api('GET', `/dashboard/manager?period=month&dataOrigin=operational&analystId=${otherTech.id}`, manager);
    assert.deepEqual(byAnalyst.body.dashboard.quality, { resolutions: 1, confirmed: 0, contested: 0, awaiting: 1, responseRate: 0, ratings: 0, averageRating: null });
    assert.equal((await api('GET', '/dashboard/manager', tech)).status, 403);
  });
});
