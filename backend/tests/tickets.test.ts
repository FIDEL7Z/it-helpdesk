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

// Integration tests: real Express app + real MongoDB. Each test file uses its own
// database because node:test runs files in parallel.
const TEST_DB_NAME = 'it-helpdesk-test-tickets';

let server: Server;
let baseUrl: string;

interface TestUser {
  id: string;
  token: string;
}

let requester: TestUser;
let otherRequester: TestUser;
let tech: TestUser;
let otherTech: TestUser;

type Body = Record<string, unknown>;

async function api(method: string, path: string, user?: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user && { Authorization: `Bearer ${user.token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Response bodies are untyped JSON in tests.
  return { status: response.status, body: (await response.json()) as Body & { [key: string]: any } };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.local`,
    passwordHash: 'not-used-tokens-are-signed-directly',
    role,
  });
  return { id: user.id, token: signAccessToken(user.id) };
}

const validTicket = {
  title: 'Impressora não imprime',
  description: 'A impressora do segundo andar não responde.',
  category: 'hardware',
  priority: 'alta',
};

async function createTicket(user: TestUser, overrides: Body = {}): Promise<string> {
  const { status, body } = await api('POST', '/tickets', user, { ...validTicket, ...overrides });
  assert.equal(status, 201);
  return body.ticket.id;
}

const MISSING_ID = new mongoose.Types.ObjectId().toString();

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);

  requester = await createUser('Requester One', 'solicitante');
  otherRequester = await createUser('Requester Two', 'solicitante');
  tech = await createUser('Tech One', 'ti');
  otherTech = await createUser('Tech Two', 'ti');

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

describe('POST /api/tickets', () => {
  it('creates a ticket owned by the authenticated user, with a creation event', async () => {
    const { status, body } = await api('POST', '/tickets', requester, validTicket);

    assert.equal(status, 201);
    assert.equal(body.ticket.requester.id, requester.id);
    assert.equal(body.ticket.status, 'aberto');
    assert.equal(body.ticket.assignee, null);
    assert.equal(body.ticket.title, validTicket.title);
    assert.equal(body.ticket.history.length, 1);
    assert.equal(body.ticket.history[0].type, 'created');
    assert.equal(body.ticket.history[0].author.id, requester.id);
    assert.equal('passwordHash' in body.ticket.requester, false);
  });

  it('defaults priority to media', async () => {
    const { priority: _ignored, ...withoutPriority } = validTicket;
    const { body } = await api('POST', '/tickets', requester, withoutPriority);
    assert.equal(body.ticket.priority, 'media');
  });

  it('requires authentication', async () => {
    const { status } = await api('POST', '/tickets', undefined, validTicket);
    assert.equal(status, 401);
  });

  it('rejects creating a ticket on behalf of someone else', async () => {
    const { status, body } = await api('POST', '/tickets', requester, {
      ...validTicket,
      requester: otherRequester.id,
    });
    assert.equal(status, 400);
    assert.match(body.formErrors.join(), /requester/);
  });

  it('rejects client-controlled status, assignee and history', async () => {
    for (const field of [{ status: 'resolvido' }, { assignee: tech.id }, { history: [] }]) {
      const { status } = await api('POST', '/tickets', requester, { ...validTicket, ...field });
      assert.equal(status, 400, JSON.stringify(field));
    }
  });

  it('validates category, priority and text lengths', async () => {
    const invalid = [
      { category: 'cafe' },
      { priority: 'urgente' },
      { title: 'ab' },
      { description: 'curta' },
      { title: undefined },
    ];
    for (const override of invalid) {
      const { status, body } = await api('POST', '/tickets', requester, { ...validTicket, ...override });
      assert.equal(status, 400, JSON.stringify(override));
      assert.ok(Object.keys(body.errors).length > 0);
    }
  });
});

describe('GET /api/tickets (listing, filters and pagination)', () => {
  before(async () => {
    await TicketModel.deleteMany({});
    // Requester One: 3 tickets. Requester Two: 2 tickets. Created in this order (oldest first).
    await createTicket(requester, { title: 'VPN não conecta', category: 'acesso', priority: 'alta' });
    await createTicket(requester, { title: 'Monitor piscando', category: 'hardware', priority: 'baixa' });
    const inProgress = await createTicket(requester, {
      title: 'Excel (365) travando',
      category: 'software',
      priority: 'media',
    });
    await createTicket(otherRequester, { title: 'Wi-Fi lento', category: 'rede', priority: 'alta' });
    await createTicket(otherRequester, { title: 'Senha expirada', category: 'acesso', priority: 'baixa' });
    await api('PATCH', `/tickets/${inProgress}/status`, tech, { status: 'em_andamento' });
  });

  it('a requester only sees their own tickets', async () => {
    const { status, body } = await api('GET', '/tickets', requester);
    assert.equal(status, 200);
    assert.equal(body.pagination.total, 3);
    assert.ok(body.tickets.every((t: Body & any) => t.requester.id === requester.id));
  });

  it('IT sees every ticket, newest first', async () => {
    const { body } = await api('GET', '/tickets', tech);
    assert.equal(body.pagination.total, 5);
    assert.equal(body.tickets[0].title, 'Senha expirada');
  });

  it('list items do not include description or history', async () => {
    const { body } = await api('GET', '/tickets', tech);
    assert.equal('description' in body.tickets[0], false);
    assert.equal('history' in body.tickets[0], false);
  });

  it('filters by status, priority and category', async () => {
    let { body } = await api('GET', '/tickets?status=em_andamento', tech);
    assert.deepEqual(body.tickets.map((t: any) => t.title), ['Excel (365) travando']);

    ({ body } = await api('GET', '/tickets?priority=alta', tech));
    assert.equal(body.pagination.total, 2);

    ({ body } = await api('GET', '/tickets?category=acesso&priority=baixa', tech));
    assert.deepEqual(body.tickets.map((t: any) => t.title), ['Senha expirada']);
  });

  it('filters never expose other requesters tickets', async () => {
    const { body } = await api('GET', '/tickets?category=rede', requester);
    assert.equal(body.pagination.total, 0);
  });

  it('searches the title case-insensitively and treats regex characters literally', async () => {
    let { body } = await api('GET', '/tickets?search=vpn', tech);
    assert.deepEqual(body.tickets.map((t: any) => t.title), ['VPN não conecta']);

    ({ body } = await api('GET', `/tickets?search=${encodeURIComponent('(365)')}`, tech));
    assert.deepEqual(body.tickets.map((t: any) => t.title), ['Excel (365) travando']);

    const { status } = await api('GET', `/tickets?search=${encodeURIComponent('.*[')}`, tech);
    assert.equal(status, 200);
  });

  it('paginates with metadata', async () => {
    const { body } = await api('GET', '/tickets?limit=2&page=2', tech);
    assert.equal(body.tickets.length, 2);
    assert.deepEqual(body.pagination, { page: 2, limit: 2, total: 5, totalPages: 3 });

    const last = await api('GET', '/tickets?limit=2&page=3', tech);
    assert.equal(last.body.tickets.length, 1);
  });

  it('validates query parameters', async () => {
    for (const query of ['limit=51', 'limit=0', 'page=0', 'page=abc', 'status=fechado', 'priority=urgente', 'category=cafe']) {
      const { status } = await api('GET', `/tickets?${query}`, tech);
      assert.equal(status, 400, query);
    }
  });
});

describe('GET /api/tickets/:id', () => {
  let ticketId: string;

  before(async () => {
    ticketId = await createTicket(requester);
  });

  it('returns details with history to the requester', async () => {
    const { status, body } = await api('GET', `/tickets/${ticketId}`, requester);
    assert.equal(status, 200);
    assert.equal(body.ticket.description, validTicket.description);
    assert.equal(body.ticket.history.length, 1);
  });

  it('returns 404 for another requester (does not reveal the ticket exists)', async () => {
    const { status } = await api('GET', `/tickets/${ticketId}`, otherRequester);
    assert.equal(status, 404);
  });

  it('IT can read any ticket', async () => {
    const { status } = await api('GET', `/tickets/${ticketId}`, tech);
    assert.equal(status, 200);
  });

  it('returns 400 for an invalid id and 404 for a missing ticket', async () => {
    assert.equal((await api('GET', '/tickets/not-an-id', tech)).status, 400);
    assert.equal((await api('GET', `/tickets/${MISSING_ID}`, tech)).status, 404);
  });
});

describe('PATCH /api/tickets/:id (edit)', () => {
  let ticketId: string;

  beforeEach(async () => {
    ticketId = await createTicket(requester);
  });

  it('the requester edits title and description while the ticket is open', async () => {
    const { status, body } = await api('PATCH', `/tickets/${ticketId}`, requester, {
      title: 'Impressora parada',
      description: 'Nenhum documento sai da impressora.',
    });
    assert.equal(status, 200);
    assert.equal(body.ticket.title, 'Impressora parada');
    const event = body.ticket.history.at(-1);
    assert.equal(event.type, 'updated');
    assert.equal(event.message, 'Título atualizado; Descrição atualizada');
  });

  it('the requester cannot edit after work has started', async () => {
    await api('PATCH', `/tickets/${ticketId}/status`, tech, { status: 'em_andamento' });
    const { status } = await api('PATCH', `/tickets/${ticketId}`, requester, { title: 'Novo título' });
    assert.equal(status, 409);
  });

  it('the requester cannot change priority or category', async () => {
    const { status } = await api('PATCH', `/tickets/${ticketId}`, requester, { priority: 'baixa' });
    assert.equal(status, 403);
  });

  it('another requester gets 404', async () => {
    const { status } = await api('PATCH', `/tickets/${ticketId}`, otherRequester, { title: 'Invasão' });
    assert.equal(status, 404);
  });

  it('rejects status, assignee, requester and history in the generic update', async () => {
    for (const field of [
      { status: 'resolvido' },
      { assignee: tech.id },
      { requester: otherRequester.id },
      { history: [] },
    ]) {
      const { status } = await api('PATCH', `/tickets/${ticketId}`, tech, field);
      assert.equal(status, 400, JSON.stringify(field));
    }
    const { body } = await api('GET', `/tickets/${ticketId}`, tech);
    assert.equal(body.ticket.status, 'aberto');
    assert.equal(body.ticket.history.length, 1);
  });

  it('IT triages category and priority, recorded in history', async () => {
    const { status, body } = await api('PATCH', `/tickets/${ticketId}`, tech, {
      category: 'rede',
      priority: 'baixa',
    });
    assert.equal(status, 200);
    const event = body.ticket.history.at(-1);
    assert.equal(event.author.id, tech.id);
    assert.equal(event.message, 'Categoria alterada de Hardware para Rede; Prioridade alterada de Alta para Baixa');
  });

  it('IT cannot edit the requester text', async () => {
    const { status } = await api('PATCH', `/tickets/${ticketId}`, tech, { title: 'Outro título' });
    assert.equal(status, 403);
  });

  it('an update with the same values creates no history event', async () => {
    const { status, body } = await api('PATCH', `/tickets/${ticketId}`, tech, { priority: 'alta' });
    assert.equal(status, 200);
    assert.equal(body.ticket.history.length, 1);
  });
});

describe('PATCH /api/tickets/:id/status', () => {
  let ticketId: string;

  beforeEach(async () => {
    ticketId = await createTicket(requester);
  });

  const setStatus = (status: string, user: TestUser = tech) =>
    api('PATCH', `/tickets/${ticketId}/status`, user, { status });

  it('requesters cannot change status', async () => {
    assert.equal((await setStatus('em_andamento', requester)).status, 403);
  });

  it('starting work assigns the technician when nobody is assigned', async () => {
    const { status, body } = await setStatus('em_andamento');
    assert.equal(status, 200);
    assert.equal(body.ticket.status, 'em_andamento');
    assert.equal(body.ticket.assignee.id, tech.id);
    assert.deepEqual(
      body.ticket.history.slice(1).map((e: any) => e.type),
      ['status_changed', 'assigned'],
    );
  });

  it('starting work keeps an existing assignee', async () => {
    await api('PATCH', `/tickets/${ticketId}/assignee`, tech, { assigneeId: otherTech.id });
    const { body } = await setStatus('em_andamento');
    assert.equal(body.ticket.assignee.id, otherTech.id);
    assert.equal(body.ticket.history.at(-1).type, 'status_changed');
  });

  it('follows the allowed transitions, including reopen', async () => {
    assert.equal((await setStatus('resolvido')).status, 409, 'aberto -> resolvido');
    assert.equal((await setStatus('aberto')).status, 409, 'aberto -> aberto');
    assert.equal((await setStatus('em_andamento')).status, 200);
    assert.equal((await setStatus('aberto')).status, 409, 'em_andamento -> aberto');
    assert.equal((await setStatus('resolvido')).status, 200);
    assert.equal((await setStatus('resolvido')).status, 409, 'resolvido -> resolvido');

    const reopened = await setStatus('em_andamento');
    assert.equal(reopened.status, 200);
    const event = reopened.body.ticket.history.at(-1);
    assert.equal(event.type, 'reopened');
    assert.equal(event.message, 'Chamado reaberto (Resolvido → Em andamento)');
  });

  it('rejects unknown status values and extra fields', async () => {
    assert.equal((await setStatus('fechado')).status, 400);
    const { status } = await api('PATCH', `/tickets/${ticketId}/status`, tech, {
      status: 'em_andamento',
      assignee: requester.id,
    });
    assert.equal(status, 400);
  });

  it('returns 400 for an invalid id and 404 for a missing ticket', async () => {
    assert.equal((await api('PATCH', '/tickets/123/status', tech, { status: 'em_andamento' })).status, 400);
    assert.equal(
      (await api('PATCH', `/tickets/${MISSING_ID}/status`, tech, { status: 'em_andamento' })).status,
      404,
    );
  });

  it('two simultaneous changes: one succeeds, the other gets 409 instead of overwriting', async () => {
    const results = await Promise.all([setStatus('em_andamento', tech), setStatus('em_andamento', otherTech)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const { body } = await api('GET', `/tickets/${ticketId}`, tech);
    assert.equal(body.ticket.history.filter((e: any) => e.type === 'status_changed').length, 1);
  });
});

describe('PATCH /api/tickets/:id/assignee', () => {
  let ticketId: string;

  beforeEach(async () => {
    ticketId = await createTicket(requester);
  });

  const assign = (assigneeId: string, user: TestUser = tech) =>
    api('PATCH', `/tickets/${ticketId}/assignee`, user, { assigneeId });

  it('IT assigns and reassigns, recorded in history', async () => {
    let { status, body } = await assign(tech.id);
    assert.equal(status, 200);
    assert.equal(body.ticket.assignee.id, tech.id);
    assert.equal(body.ticket.history.at(-1).message, 'Responsável definido: Tech One');

    ({ body } = await assign(otherTech.id));
    assert.equal(body.ticket.history.at(-1).message, 'Responsável alterado de Tech One para Tech Two');
  });

  it('only users with the ti role can be assigned', async () => {
    const { status, body } = await assign(requester.id);
    assert.equal(status, 400);
    assert.equal(body.message, 'Assignee must be an IT team member');
    assert.equal((await assign(MISSING_ID)).status, 400);
    assert.equal((await assign('not-an-id')).status, 400);
  });

  it('requesters cannot assign, not even themselves', async () => {
    assert.equal((await assign(requester.id, requester)).status, 403);
    assert.equal((await assign(tech.id, requester)).status, 403);
  });

  it('resolved tickets cannot be reassigned', async () => {
    await api('PATCH', `/tickets/${ticketId}/status`, tech, { status: 'em_andamento' });
    await api('PATCH', `/tickets/${ticketId}/status`, tech, { status: 'resolvido' });
    assert.equal((await assign(otherTech.id)).status, 409);
  });
});

describe('GET /api/users/it-staff', () => {
  it('lists only IT users, for IT', async () => {
    const { status, body } = await api('GET', '/users/it-staff', tech);
    assert.equal(status, 200);
    assert.deepEqual(body.users.map((u: any) => u.name), ['Tech One', 'Tech Two']);
    assert.ok(body.users.every((u: any) => !('passwordHash' in u)));
  });

  it('is forbidden for requesters', async () => {
    assert.equal((await api('GET', '/users/it-staff', requester)).status, 403);
  });
});
