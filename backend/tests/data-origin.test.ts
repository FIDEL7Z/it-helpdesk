import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { IncidentParticipationModel, SharedIncidentModel } from '../src/models/incident.model';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// One origin policy for lists, indicators and incidents (services/data-origin.ts).
const TEST_DB_NAME = 'it-helpdesk-test-data-origin';

let server: Server;
let baseUrl: string;
type TestUser = { id: string; token: string };
type Json = { [key: string]: any };
let realRequester: TestUser, realTech: TestUser, manager: TestUser, demoRequester: TestUser, demoTech: TestUser;

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, email: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

const newTicket = async (user: TestUser, title: string) => {
  const created = await api('POST', '/tickets', user, { title, description: 'Descrição suficiente para o teste de origem.', category: 'rede' });
  assert.equal(created.status, 201);
  return created.body.ticket.id as string;
};
const storedOrigin = async (id: string) => (await TicketModel.findById(id).lean())?.dataOrigin;

const demoMode = env.DEMO_MODE;
const nodeEnv = process.env.NODE_ENV;
const setMode = (demo: boolean, production = false) => { env.DEMO_MODE = demo; process.env.NODE_ENV = production ? 'production' : 'test'; };

let demoTicket: string, realTicket: string, legacyTicket: string;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes(), SharedIncidentModel.syncIndexes(), IncidentParticipationModel.syncIndexes()]);
  realRequester = await createUser('Paula Real', 'paula@empresa.test', 'solicitante');
  realTech = await createUser('Rui Real', 'rui@empresa.test', 'ti');
  manager = await createUser('Gina Real', 'gina@empresa.test', 'gestor');
  demoRequester = await createUser('Mariana Souza', 'solicitante@helpdesk.local', 'solicitante');
  demoTech = await createUser('Carlos Andrade', 'ti@helpdesk.local', 'ti');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => { env.DEMO_MODE = demoMode; process.env.NODE_ENV = nodeEnv; });

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('data origin policy', () => {
  it('classifies a ticket by who created it, never by the absence of operational data', async () => {
    setMode(true);
    // No operational ticket exists yet: the demo account's ticket is still demo, and a real one is operational.
    demoTicket = await newTicket(demoRequester, 'Origem: conta fictícia');
    assert.equal(await storedOrigin(demoTicket), 'demo');
    realTicket = await newTicket(realRequester, 'Origem: conta real');
    assert.equal(await storedOrigin(realTicket), 'operational');
    setMode(false);
    assert.equal(await storedOrigin(await newTicket(realRequester, 'Origem: conta real sem modo demo')), 'operational');
    legacyTicket = (await TicketModel.create({ title: 'Origem: legado', description: 'Registro antigo sem origem comprovada.', category: 'rede', requester: realRequester.id })).id;
  });

  it('shows only operational data when the demonstration mode is off, and refuses other origins', async () => {
    setMode(false);
    const listed = (await api('GET', '/tickets?limit=50', manager)).body.tickets.map((t: Json) => t.id);
    assert.ok(listed.includes(realTicket));
    assert.ok(!listed.includes(demoTicket) && !listed.includes(legacyTicket));
    for (const path of ['/tickets?dataOrigin=demo', '/tickets?dataOrigin=legacy', '/dashboard/summary?dataOrigin=demo', '/dashboard/manager?dataOrigin=legacy', '/incidents/manage?dataOrigin=demo', '/incidents/indicators?dataOrigin=demo']) {
      assert.equal((await api('GET', path, manager)).status, 403, path);
    }
    assert.equal((await api('GET', '/dashboard/summary', manager)).body.summary.byStatus.total, 2);
  });

  it('applies the same restriction in production even with DEMO_MODE=true', async () => {
    setMode(true, true);
    assert.equal((await api('GET', '/tickets?dataOrigin=demo', manager)).status, 403);
    assert.equal((await api('GET', '/dashboard/manager?dataOrigin=demo', manager)).status, 403);
    const listed = (await api('GET', '/tickets?limit=50', realTech)).body.tickets.map((t: Json) => t.id);
    assert.ok(!listed.includes(demoTicket));
    assert.equal((await api('GET', '/dashboard/manager', manager)).body.dashboard.demoControlsEnabled, false);
  });

  it('in the demonstration mode, serves each origin only when asked, and all of them only without a filter', async () => {
    setMode(true);
    const ids = async (query: string) => (await api('GET', `/tickets?limit=50${query}`, manager)).body.tickets.map((t: Json) => t.id).sort();
    assert.deepEqual(await ids('&dataOrigin=demo'), [demoTicket]);
    assert.deepEqual(await ids('&dataOrigin=legacy'), [legacyTicket]);
    assert.ok((await ids('&dataOrigin=operational')).includes(realTicket));
    assert.equal((await ids('')).length, 4, 'no filter = every origin, which the interface labels per record');
    const team = (await api('GET', '/tickets?limit=50', manager)).body.tickets;
    assert.ok(team.every((t: Json) => ['operational', 'demo', 'legacy'].includes(t.dataOrigin)), 'each team record carries its origin');
    assert.equal(await storedOrigin(legacyTicket), 'legacy', 'listing never migrates legacy records');
  });

  it('keeps fictitious incidents out of known problems outside the demonstration mode', async () => {
    setMode(true);
    assert.equal((await api('POST', `/tickets/${demoTicket}/incident`, demoTech, { title: 'Incidente fictício', publicMessage: 'Mensagem de demonstração para os afetados.' })).status, 201);
    assert.equal((await api('POST', `/tickets/${realTicket}/incident`, realTech, { title: 'Incidente real', publicMessage: 'A equipe está cuidando do problema relatado.' })).status, 201);
    const titles = async () => (await api('GET', '/incidents', realRequester)).body.incidents.map((i: Json) => i.title).sort();
    assert.deepEqual(await titles(), ['Incidente fictício', 'Incidente real']);
    setMode(false);
    assert.deepEqual(await titles(), ['Incidente real']);
    assert.deepEqual((await api('GET', '/incidents/manage', realTech)).body.incidents.map((i: Json) => i.title), ['Incidente real']);
  });
});
