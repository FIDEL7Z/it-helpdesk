import { after, before, describe, it } from 'node:test';
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

// Shared incidents: integration tests with the real Express app and MongoDB, own database.
const TEST_DB_NAME = 'it-helpdesk-test-incidents';
const PRIVATE_TEXT = 'Detalhe privado: senha do roteador anotada no chamado';

let server: Server;
let baseUrl: string;

interface TestUser { id: string; token: string; email: string; name: string }
let requester: TestUser;
let otherRequester: TestUser;
let thirdRequester: TestUser;
let tech: TestUser;
let manager: TestUser;

type Json = { [key: string]: any };

async function api(method: string, path: string, user?: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user && { Authorization: `Bearer ${user.token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  // Response bodies are untyped JSON in tests.
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Json, raw: text };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@test.local`;
  const user = await UserModel.create({ name, email, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id), email, name };
}

async function createTicket(user: TestUser, title = 'Wi-Fi caiu no 2º andar'): Promise<Json> {
  const { status, body } = await api('POST', '/tickets', user, {
    title, description: PRIVATE_TEXT, category: 'rede', priority: 'alta',
  });
  assert.equal(status, 201);
  return body.ticket;
}

const publishBody = { title: 'Instabilidade na rede Wi-Fi', publicMessage: 'A equipe de TI identificou uma instabilidade na rede Wi-Fi. Estamos trabalhando para normalizar o acesso.' };

async function publish(ticketId: string, user: TestUser = tech): Promise<Json> {
  const { status, body } = await api('POST', `/tickets/${ticketId}/incident`, user, publishBody);
  assert.equal(status, 201, JSON.stringify(body));
  return body.incident;
}

async function ticketRevision(ticketId: string): Promise<number> {
  return (await api('GET', `/tickets/${ticketId}`, tech)).body.ticket.revision;
}

/** Starts and resolves a ticket as `tech` (the assignee resolves, no justification needed). */
async function resolveTicket(ticketId: string): Promise<void> {
  const started = await api('PATCH', `/tickets/${ticketId}/status`, tech, { status: 'em_andamento', expectedRevision: await ticketRevision(ticketId) });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const resolved = await api('PATCH', `/tickets/${ticketId}/status`, tech, { status: 'resolvido', expectedRevision: started.body.ticket.revision });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
}

const join = (incidentId: string, user: TestUser, body?: unknown) => api('PUT', `/incidents/${incidentId}/participation`, user, body);
const leave = (incidentId: string, user: TestUser) => api('DELETE', `/incidents/${incidentId}/participation`, user);

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes(), SharedIncidentModel.syncIndexes(), IncidentParticipationModel.syncIndexes()]);

  requester = await createUser('Requester One', 'solicitante');
  otherRequester = await createUser('Requester Two', 'solicitante');
  thirdRequester = await createUser('Requester Three', 'solicitante');
  tech = await createUser('Tech One', 'ti');
  manager = await createUser('Manager One', 'gestor');

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('publishing a shared incident', () => {
  it('only TI and managers can publish, edit, close and see the operational list', async () => {
    const ticket = await createTicket(requester);
    assert.equal((await api('POST', `/tickets/${ticket.id}/incident`, requester, publishBody)).status, 403);

    const incident = await publish(ticket.id, tech);
    assert.equal((await api('PATCH', `/incidents/${incident.id}`, requester, { title: 'Editado pelo solicitante', expectedRevision: incident.revision })).status, 403);
    assert.equal((await api('POST', `/incidents/${incident.id}/close`, requester, { resolutionMessage: 'Fechado por quem não pode.', expectedRevision: incident.revision })).status, 403);
    assert.equal((await api('GET', '/incidents/manage', requester)).status, 403);
    assert.equal((await api('GET', '/incidents/indicators', requester)).status, 403);

    const managerTicket = await createTicket(otherRequester, 'Sistema de ponto fora do ar');
    const managerIncident = await publish(managerTicket.id, manager);
    assert.equal(managerIncident.publishedBy.id, manager.id);
  });

  it('requires title and public message; author, dates and status come from the server', async () => {
    const ticket = await createTicket(requester);
    assert.equal((await api('POST', `/tickets/${ticket.id}/incident`, tech, { title: 'Sem mensagem' })).status, 400);
    for (const extra of [{ status: 'closed' }, { publishedBy: requester.id }, { publishedAt: '2020-01-01T00:00:00.000Z' }, { ticket: ticket.id }]) {
      assert.equal((await api('POST', `/tickets/${ticket.id}/incident`, tech, { ...publishBody, ...extra })).status, 400, JSON.stringify(extra));
    }
    const incident = await publish(ticket.id);
    assert.equal(incident.status, 'active');
    assert.equal(incident.ticketId, ticket.id);
    assert.equal(incident.history[0].type, 'published');
    assert.equal(incident.history[0].actor.id, tech.id);
  });

  it('a ticket has at most one incident, even with simultaneous publications', async () => {
    const ticket = await createTicket(requester);
    const results = await Promise.all([1, 2, 3].map(() => api('POST', `/tickets/${ticket.id}/incident`, tech, publishBody)));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409, 409]);
    assert.equal(await SharedIncidentModel.countDocuments({ ticket: ticket.id }), 1);
  });

  it('a resolved ticket cannot publish an incident', async () => {
    const ticket = await createTicket(requester);
    await resolveTicket(ticket.id);
    assert.equal((await api('POST', `/tickets/${ticket.id}/incident`, tech, publishBody)).status, 409);
  });

  it("a requester cannot publish from someone else's ticket, and the ticket stays private (404)", async () => {
    const ticket = await createTicket(otherRequester);
    assert.equal((await api('GET', `/tickets/${ticket.id}/incident`, requester)).status, 403);
    assert.equal((await api('GET', `/tickets/${ticket.id}`, requester)).status, 404);
  });
});

describe('public data and privacy', () => {
  let incident: Json;

  before(async () => {
    const ticket = await createTicket(requester);
    incident = await publish(ticket.id);
    await join(incident.id, requester);
  });

  it('requesters receive only the public fields', async () => {
    const { status, body, raw } = await api('GET', '/incidents', otherRequester);
    assert.equal(status, 200);
    const item = body.incidents.find((candidate: Json) => candidate.id === incident.id);
    assert.deepEqual(Object.keys(item).sort(),
      ['affectedCount', 'closedAt', 'following', 'id', 'publicMessage', 'publishedAt', 'resolutionMessage', 'status', 'title']);
    for (const secret of [PRIVATE_TEXT, incident.ticketId, requester.email, requester.name, requester.id, tech.id, 'history', 'publishedBy']) {
      assert.equal(raw.includes(secret), false, `leaked: ${secret}`);
    }
  });

  it('a single public incident has the same shape', async () => {
    const { body, raw } = await api('GET', `/incidents/${incident.id}`, thirdRequester);
    assert.equal(body.incident.title, publishBody.title);
    assert.equal(raw.includes(PRIVATE_TEXT), false);
    assert.equal(raw.includes(requester.email), false);
  });

  it('returns 404 for an unknown incident and 400 for an invalid id', async () => {
    assert.equal((await api('GET', `/incidents/${new mongoose.Types.ObjectId()}`, requester)).status, 404);
    assert.equal((await api('GET', '/incidents/not-an-id', requester)).status, 400);
  });
});

describe('"I am affected too" (participation)', () => {
  let incident: Json;
  let ticketId: string;

  before(async () => {
    const ticket = await createTicket(requester);
    ticketId = ticket.id;
    incident = await publish(ticket.id);
  });

  it('is idempotent: clicking again does not increase the count', async () => {
    const first = await join(incident.id, otherRequester);
    const second = await join(incident.id, otherRequester);
    assert.equal(first.body.incident.affectedCount, 1);
    assert.equal(second.body.incident.affectedCount, 1);
    assert.equal(second.body.incident.following, true);
  });

  it('stays consistent with simultaneous clicks from the same and from different people', async () => {
    await Promise.all([...Array(10)].map(() => join(incident.id, thirdRequester)));
    await Promise.all([join(incident.id, requester), join(incident.id, tech), join(incident.id, manager)]);
    const { body } = await api('GET', `/incidents/${incident.id}`, requester);
    assert.equal(body.incident.affectedCount, 5);
    assert.equal(await IncidentParticipationModel.countDocuments({ incident: incident.id, user: thirdRequester.id }), 1);
  });

  it('cannot enrol someone else: the body is rejected and the user comes from the token', async () => {
    const before = (await api('GET', `/incidents/${incident.id}`, requester)).body.incident.affectedCount;
    assert.equal((await join(incident.id, requester, { userId: otherRequester.id })).status, 400);
    assert.equal((await api('GET', `/incidents/${incident.id}`, requester)).body.incident.affectedCount, before);
  });

  it('reports the participation of the authenticated user', async () => {
    const { body } = await api('GET', `/incidents/${incident.id}/participation`, otherRequester);
    assert.deepEqual(body, { following: true, affectedCount: 5 });
  });

  it('leaving, leaving again and joining again keep a correct count', async () => {
    let result = await leave(incident.id, otherRequester);
    assert.equal(result.body.incident.following, false);
    assert.equal(result.body.incident.affectedCount, 4);
    result = await leave(incident.id, otherRequester);
    assert.equal(result.body.incident.affectedCount, 4);
    result = await join(incident.id, otherRequester);
    assert.equal(result.body.incident.affectedCount, 5);
    assert.equal(await IncidentParticipationModel.countDocuments({ incident: incident.id, user: otherRequester.id }), 1);
  });

  it('participations never change the ticket revision or its history', async () => {
    const before = await api('GET', `/tickets/${ticketId}`, tech);
    await join(incident.id, requester);
    await leave(incident.id, requester);
    await join(incident.id, requester);
    const afterJoin = await api('GET', `/tickets/${ticketId}`, tech);
    assert.equal(afterJoin.body.ticket.revision, before.body.ticket.revision);
    assert.equal(afterJoin.body.ticket.history.length, before.body.ticket.history.length);
  });
});

describe('editing the public text', () => {
  it('uses the incident revision and records the author', async () => {
    const ticket = await createTicket(requester);
    const incident = await publish(ticket.id);
    const stale = await api('PATCH', `/incidents/${incident.id}`, manager, { publicMessage: 'Mensagem com revisão antiga.', expectedRevision: incident.revision - 1 || 99 });
    assert.equal(stale.status, 409);

    const [first, second] = await Promise.all([
      api('PATCH', `/incidents/${incident.id}`, manager, { publicMessage: 'Primeira atualização simultânea.', expectedRevision: incident.revision }),
      api('PATCH', `/incidents/${incident.id}`, tech, { publicMessage: 'Segunda atualização simultânea.', expectedRevision: incident.revision }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);

    const winner = first.status === 200 ? first.body.incident : second.body.incident;
    const event = winner.history.at(-1);
    assert.equal(event.type, 'updated');
    assert.equal(event.actor.id, first.status === 200 ? manager.id : tech.id);
    assert.equal(event.revision, incident.revision + 1);
    assert.equal(typeof event.from.publicMessage, 'string');
  });
});

describe('closing', () => {
  it('resolving the main ticket closes the incident, attributed to who resolved it', async () => {
    const ticket = await createTicket(requester);
    const incident = await publish(ticket.id, manager);
    await join(incident.id, otherRequester);
    await resolveTicket(ticket.id);

    const stored = await SharedIncidentModel.findById(incident.id);
    assert.equal(stored?.status, 'closed');
    assert.equal(stored?.closeReason, 'ticket_resolved');
    assert.equal(stored?.closedBy?.toString(), tech.id);
    assert.equal(stored?.history.at(-1)?.type, 'closed');

    const active = await api('GET', '/incidents', otherRequester);
    assert.equal(active.body.incidents.some((item: Json) => item.id === incident.id), false);
    assert.equal((await join(incident.id, thirdRequester)).status, 409);
  });

  it('followers can still read the result; others cannot see a closed incident', async () => {
    const ticket = await createTicket(requester);
    const incident = await publish(ticket.id);
    await join(incident.id, otherRequester);
    const closed = await api('POST', `/incidents/${incident.id}/close`, tech, { resolutionMessage: 'Rede normalizada após troca do equipamento.', expectedRevision: incident.revision });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.incident.closeReason, 'manual');

    const followed = await api('GET', '/incidents/following', otherRequester);
    const item = followed.body.incidents.find((candidate: Json) => candidate.id === incident.id);
    assert.equal(item.status, 'closed');
    assert.equal(item.resolutionMessage, 'Rede normalizada após troca do equipamento.');
    assert.equal((await api('GET', `/incidents/${incident.id}`, thirdRequester)).status, 404);
    assert.equal((await api('GET', `/incidents/${incident.id}`, manager)).status, 200);
  });

  it('manual close needs a public resolution message and the current revision', async () => {
    const ticket = await createTicket(requester);
    const incident = await publish(ticket.id);
    assert.equal((await api('POST', `/incidents/${incident.id}/close`, tech, { expectedRevision: incident.revision })).status, 400);
    assert.equal((await api('POST', `/incidents/${incident.id}/close`, tech, { resolutionMessage: 'Mensagem de encerramento.', expectedRevision: 99 })).status, 409);
  });

  it('repairs a missed close: never shown as active once the main ticket is resolved', async () => {
    const ticket = await createTicket(requester);
    const incident = await publish(ticket.id);
    // Simulates a failure between "resolve ticket" and "close incident".
    await TicketModel.updateOne({ _id: ticket.id }, { $set: { status: 'resolvido', resolvedBy: tech.id, resolvedAt: new Date() } });

    const active = await api('GET', '/incidents', requester);
    assert.equal(active.body.incidents.some((item: Json) => item.id === incident.id), false);
    const stored = await SharedIncidentModel.findById(incident.id);
    assert.equal(stored?.status, 'closed');
    assert.equal(stored?.closeReason, 'ticket_resolved');
    assert.equal(stored?.closedBy?.toString(), tech.id);
  });
});

describe('reopening the main ticket', () => {
  it('does not reactivate the old publication; republishing starts a new cycle', async () => {
    const ticket = await createTicket(requester);
    const incident = await publish(ticket.id);
    await join(incident.id, otherRequester);
    await resolveTicket(ticket.id);

    const closed = (await api('GET', `/tickets/${ticket.id}/incident`, tech)).body.incident;
    const republishBody = { title: 'Instabilidade na rede Wi-Fi (retorno)', publicMessage: 'O problema voltou a ocorrer em parte do 2º andar.', expectedRevision: closed.revision };
    assert.equal((await api('POST', `/incidents/${incident.id}/republish`, tech, republishBody)).status, 409, 'ticket still resolved');

    const reopened = await api('PATCH', `/tickets/${ticket.id}/status`, tech, { status: 'em_andamento', expectedRevision: await ticketRevision(ticket.id), reason: 'Usuários relataram nova queda' });
    assert.equal(reopened.status, 200);
    assert.equal((await SharedIncidentModel.findById(incident.id))?.status, 'closed', 'reopen keeps the incident closed');

    assert.equal((await api('POST', `/incidents/${incident.id}/republish`, tech, { ...republishBody, expectedRevision: 99 })).status, 409);
    const republished = await api('POST', `/incidents/${incident.id}/republish`, tech, republishBody);
    assert.equal(republished.status, 200);
    assert.equal(republished.body.incident.status, 'active');
    assert.equal(republished.body.incident.cycle, 2);
    assert.equal(republished.body.incident.affectedCount, 0, 'people confirm again in the new cycle');
    assert.equal(republished.body.incident.history.at(-1).type, 'republished');

    const view = await api('GET', `/incidents/${incident.id}`, otherRequester);
    assert.equal(view.body.incident.following, false);
    assert.equal(view.body.incident.title, 'Instabilidade na rede Wi-Fi (retorno)');
  });
});

describe('ticket list, legacy tickets and indicators', () => {
  it('the team sees the incident marker; requesters do not receive it', async () => {
    const ticket = await createTicket(requester, 'Chamado com marcador de incidente');
    const incident = await publish(ticket.id);
    await join(incident.id, otherRequester);

    const teamList = await api('GET', `/tickets?search=${encodeURIComponent('marcador de incidente')}`, tech);
    assert.deepEqual(teamList.body.tickets[0].incident, { id: incident.id, status: 'active', affectedCount: 1 });
    const requesterList = await api('GET', `/tickets?search=${encodeURIComponent('marcador de incidente')}`, requester);
    assert.equal('incident' in requesterList.body.tickets[0], false);
  });

  it('tickets without incidents keep working (legacy data)', async () => {
    const legacy = await TicketModel.create({ title: 'Chamado antigo', description: 'Criado antes dos incidentes.', category: 'outros', priority: 'baixa',
      status: 'aberto', requester: requester.id, history: [] });
    assert.equal((await api('GET', `/tickets/${legacy.id}/incident`, tech)).body.incident, null);
    assert.equal((await api('GET', `/tickets/${legacy.id}`, requester)).status, 200);
  });

  it('managers get incident indicators without a "tickets avoided" claim', async () => {
    const { status, body } = await api('GET', '/incidents/indicators', manager);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.indicators).sort(), ['active', 'affectedInActive', 'closed', 'newParticipations30Days', 'top']);
    assert.ok(body.indicators.active >= 1);
    assert.ok(body.indicators.top.every((item: Json, index: number, list: Json[]) => index === 0 || list[index - 1].affectedCount >= item.affectedCount));
  });
});
