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

// What each profile receives about a ticket, checked on the raw API response (not on the UI).
const TEST_DB_NAME = 'it-helpdesk-test-ticket-privacy';
const PRIORITY_REASON = 'Motivo interno: diretoria aguardando o equipamento';
const RESOLUTION_REASON = 'Justificativa interna: resolvido por outro analista após diagnóstico';
const REOPEN_REASON = 'Reabertura interna: falha voltou no teste de carga';

const REQUESTER_SUMMARY_KEYS = ['assignee', 'category', 'createdAt', 'id', 'priority', 'requesterId', 'resolvedAt', 'revision', 'status', 'title', 'updatedAt'];
// intake: the requester's own guided-form answers (null when there are none).
const REQUESTER_DETAIL_KEYS = [...REQUESTER_SUMMARY_KEYS, 'description', 'history', 'intake'].sort();
const REQUESTER_EVENT_KEYS = ['at', 'author', 'message', 'type'];

let server: Server;
let baseUrl: string;

interface TestUser { id: string; token: string; email: string; name: string }
let requester: TestUser;
let tech: TestUser;
let manager: TestUser;
let handledTicketId: string;

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
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@privacy.test`;
  const user = await UserModel.create({ name, email, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id), email, name };
}

async function mutate(path: string, user: TestUser, body: Json): Promise<Json> {
  const revision = (await api('GET', path.replace(/\/(status|assignee)$/, ''), tech)).body.ticket.revision;
  const result = await api('PATCH', path, user, { ...body, expectedRevision: revision });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

/** Fails with the offending value, so a leak is easy to spot in the test output. */
function assertNoRestrictedData(raw: string): void {
  for (const restricted of [
    PRIORITY_REASON, RESOLUTION_REASON, REOPEN_REASON, tech.email, manager.email, requester.email, tech.id, manager.id,
    '"audit"', '"authorId"', '"assigneeAtEvent"', '"assigneeId"', '"resolvedBy"', '"resolvedById"', '"activeCycleId"',
    '"dataOrigin"', '"email"', '"role"', '"actorId"', '"operationId"', '"reason"',
  ]) {
    assert.equal(raw.includes(restricted), false, `requester response must not include ${restricted}`);
  }
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  requester = await createUser('Paula Pedido', 'solicitante');
  tech = await createUser('Tiago Tecnico', 'ti');
  manager = await createUser('Gina Gestora', 'gestor');

  // A ticket with every kind of internal data: assignment, a justified priority change,
  // resolution by someone other than the assignee, and a justified reopening.
  const created = await api('POST', '/tickets', requester, {
    title: 'Notebook não liga', description: 'Desde ontem o notebook não liga mais.', category: 'hardware', priority: 'media',
  });
  assert.equal(created.status, 201);
  handledTicketId = created.body.ticket.id;
  const path = `/tickets/${handledTicketId}`;
  await mutate(`${path}/status`, tech, { status: 'em_andamento' });
  await mutate(path, manager, { priority: 'alta', reason: PRIORITY_REASON });
  await mutate(`${path}/status`, manager, { status: 'resolvido', reason: RESOLUTION_REASON });
  await mutate(`${path}/status`, tech, { status: 'em_andamento', reason: REOPEN_REASON });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('ticket data received by the requester', () => {
  it('detail: only the allowlisted fields, a public timeline and names without contact data', async () => {
    const { status, body, raw } = await api('GET', `/tickets/${handledTicketId}`, requester);

    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.ticket).sort(), REQUESTER_DETAIL_KEYS);
    assert.deepEqual(body.ticket.assignee, { name: tech.name });
    assert.equal(body.ticket.requesterId, requester.id);
    // The whole history stays available, without the audit metadata behind each event.
    assert.equal(body.ticket.history.length, 6);
    for (const event of body.ticket.history) {
      assert.deepEqual(Object.keys(event).sort(), REQUESTER_EVENT_KEYS);
      assert.deepEqual(Object.keys(event.author), ['name']);
    }
    assert.deepEqual(body.ticket.history.map((event: Json) => event.type), ['created', 'status_changed', 'assigned', 'updated', 'resolved', 'reopened']);
    assert.equal(body.ticket.history.find((event: Json) => event.type === 'resolved').author.name, manager.name);
    assertNoRestrictedData(raw);
  });

  it('list and home summary use the same allowlist', async () => {
    const list = await api('GET', '/tickets', requester);
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys(list.body.tickets[0]).sort(), REQUESTER_SUMMARY_KEYS);
    assertNoRestrictedData(list.raw);

    const summary = await api('GET', '/dashboard/summary', requester);
    assert.equal(summary.status, 200);
    assert.deepEqual(Object.keys(summary.body.summary.recent[0]).sort(), REQUESTER_SUMMARY_KEYS);
    assertNoRestrictedData(summary.raw);
  });

  it('responses to the requester own writes use the same allowlist', async () => {
    const created = await api('POST', '/tickets', requester, {
      title: 'Mouse sem resposta', description: 'O mouse sem fio parou de responder.', category: 'hardware',
    });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.body.ticket).sort(), REQUESTER_DETAIL_KEYS);
    assertNoRestrictedData(created.raw);

    const edited = await api('PATCH', `/tickets/${created.body.ticket.id}`, requester, {
      description: 'O mouse sem fio parou de responder mesmo com pilhas novas.', expectedRevision: created.body.ticket.revision,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(Object.keys(edited.body.ticket).sort(), REQUESTER_DETAIL_KEYS);
    assert.equal(edited.body.ticket.revision, created.body.ticket.revision + 1);
    assertNoRestrictedData(edited.raw);
  });
});

describe('ticket data received by the team', () => {
  for (const role of ['ti', 'gestor'] as const) {
    it(`${role}: keeps the operational contract with audit, justifications and cycles`, async () => {
      const viewer = role === 'ti' ? tech : manager;
      const { status, body } = await api('GET', `/tickets/${handledTicketId}`, viewer);

      assert.equal(status, 200);
      assert.equal(body.ticket.requester.email, requester.email);
      assert.equal(body.ticket.assignee.id, tech.id);
      assert.equal(body.ticket.activeCycleId, 2);
      assert.equal(typeof body.ticket.dataOrigin, 'string');
      const resolved = body.ticket.history.find((event: Json) => event.type === 'resolved');
      assert.equal(resolved.audit.reason, RESOLUTION_REASON);
      assert.equal(resolved.audit.actorId, manager.id);
      assert.equal(resolved.authorId, manager.id);
      assert.equal(resolved.assigneeAtEvent.id, tech.id);
      assert.equal(body.ticket.history.find((event: Json) => event.type === 'updated').audit.reason, PRIORITY_REASON);
    });
  }
});
