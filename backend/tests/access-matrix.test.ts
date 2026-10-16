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

// Direct API calls without the right permission, route by route: the backend decides, not the UI.
const TEST_DB_NAME = 'it-helpdesk-test-access-matrix';
const ID = '0123456789abcdef01234567';

let server: Server;
let baseUrl: string;
type TestUser = { id: string; token: string };
let requester: TestUser, otherRequester: TestUser, tech: TestUser, manager: TestUser;

async function call(method: string, path: string, token?: string, body: unknown = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@access.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

// Every authenticated route of the API (method, path), with ids where the route needs one.
const AUTHENTICATED: [string, string][] = [
  ['GET', '/auth/me'], ['GET', '/dashboard/summary'], ['GET', '/dashboard/manager'], ['GET', '/users/it-staff'],
  ['POST', '/tickets'], ['GET', '/tickets'], ['GET', '/tickets/intake-questions'], ['GET', `/tickets/${ID}`], ['PATCH', `/tickets/${ID}`],
  ['PATCH', `/tickets/${ID}/status`], ['PATCH', `/tickets/${ID}/assignee`], ['GET', `/tickets/${ID}/incident`], ['POST', `/tickets/${ID}/incident`],
  ['POST', `/tickets/${ID}/resolution/confirm`], ['POST', `/tickets/${ID}/resolution/contest`], ['POST', `/tickets/${ID}/resolution/rating`],
  ['GET', '/incidents'], ['GET', '/incidents/following'], ['GET', '/incidents/manage'], ['GET', '/incidents/indicators'], ['GET', `/incidents/${ID}`],
  ['PATCH', `/incidents/${ID}`], ['POST', `/incidents/${ID}/close`], ['POST', `/incidents/${ID}/republish`],
  ['GET', `/incidents/${ID}/participation`], ['PUT', `/incidents/${ID}/participation`], ['DELETE', `/incidents/${ID}/participation`],
  ['GET', '/articles'], ['GET', '/articles/manage'], ['POST', '/articles'], ['GET', `/articles/${ID}`], ['PATCH', `/articles/${ID}`], ['PUT', `/articles/${ID}/feedback`],
];

// Team or management only: a requester must get 403 before any data is read.
const TEAM_ONLY: [string, string][] = [
  ['GET', '/dashboard/manager'], ['GET', '/users/it-staff'],
  ['PATCH', `/tickets/${ID}/status`], ['PATCH', `/tickets/${ID}/assignee`], ['GET', `/tickets/${ID}/incident`], ['POST', `/tickets/${ID}/incident`],
  ['GET', '/incidents/manage'], ['GET', '/incidents/indicators'], ['PATCH', `/incidents/${ID}`], ['POST', `/incidents/${ID}/close`], ['POST', `/incidents/${ID}/republish`],
  ['GET', '/articles/manage'], ['POST', '/articles'], ['PATCH', `/articles/${ID}`],
];

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);
  requester = await createUser('Ada Pedido', 'solicitante');
  otherRequester = await createUser('Bia Pedido', 'solicitante');
  tech = await createUser('Caio Suporte', 'ti');
  manager = await createUser('Dora Gestora', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('direct API access matrix', () => {
  it('every authenticated route answers 401 without a token or with a forged one', async () => {
    const forged = `${tech.token.split('.').slice(0, 2).join('.')}.forged-signature`;
    for (const [method, path] of AUTHENTICATED) {
      assert.equal((await call(method, path)).status, 401, `${method} ${path} without token`);
      assert.equal((await call(method, path, forged)).status, 401, `${method} ${path} with a forged token`);
    }
    assert.equal((await call('GET', '/health')).status, 200, 'only health and login are public');
  });

  it('a requester gets 403 on every team or management route', async () => {
    for (const [method, path] of TEAM_ONLY) {
      assert.equal((await call(method, path, requester.token)).status, 403, `${method} ${path}`);
    }
  });

  it('IT operates tickets but cannot read the management indicators', async () => {
    assert.equal((await call('GET', '/dashboard/manager', tech.token)).status, 403);
    assert.equal((await call('GET', '/dashboard/manager', manager.token)).status, 200);
    const summary = (await call('GET', '/dashboard/summary', tech.token)).body.summary;
    for (const key of ['team', 'quality', 'workloadBalance', 'requesters', 'coverage']) assert.equal(key in summary, false, `summary has no ${key}`);
  });

  it("a requester cannot read or answer someone else's ticket: 404, as if it did not exist", async () => {
    const created = await call('POST', '/tickets', otherRequester.token, { title: 'Pedido de outra pessoa', description: 'Somente a dona do pedido pode ver.', category: 'rede' });
    assert.equal(created.status, 201);
    const id = created.body.ticket.id;
    assert.equal((await call('GET', `/tickets/${id}`, requester.token)).status, 404);
    assert.equal((await call('PATCH', `/tickets/${id}`, requester.token, { title: 'Tentativa', expectedRevision: 1 })).status, 404);
    const answers: [string, object][] = [['confirm', { cycleId: 1 }], ['contest', { cycleId: 1, reason: 'Tentativa de terceiro.' }], ['rating', { cycleId: 1, rating: 5 }]];
    for (const [action, body] of answers) {
      assert.equal((await call('POST', `/tickets/${id}/resolution/${action}`, requester.token, body)).status, 404, action);
    }
    const listed = (await call('GET', '/tickets?limit=50', requester.token)).body.tickets.map((t: { id: string }) => t.id);
    assert.equal(listed.includes(id), false);
  });

  it('identity always comes from the token, never from the request', async () => {
    const created = await call('POST', '/tickets', requester.token, { title: 'Pedido próprio', description: 'O solicitante vem do token.', category: 'rede', requester: otherRequester.id });
    assert.equal(created.status, 400, 'a requester field in the body is rejected');
    const me = (await call('GET', `/auth/me?id=${manager.id}`, requester.token)).body.user;
    assert.equal(me.id, requester.id);
  });
});
