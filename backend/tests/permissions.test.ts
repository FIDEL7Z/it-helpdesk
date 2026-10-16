import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { PERMISSIONS, can, type Permission } from '../src/auth/permissions';
import { env } from '../src/config/env';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// Authorization matrix for the three roles. Own database and own process
// (node:test runs test files in parallel).
const TEST_DB_NAME = 'it-helpdesk-test-permissions';

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
let manager: TestUser;

async function api(method: string, path: string, user?: TestUser, body?: unknown) {
  if (method === 'PATCH' && body && typeof body === 'object' && !('expectedRevision' in body)) {
    const ticketPath = path.replace(/\/(status|assignee)$/, '');
    const latest = await api('GET', ticketPath, user);
    body = { ...body, expectedRevision: latest.body.ticket?.revision ?? 0, reason: 'Motivo explícito do cenário de teste' };
  }
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user && { Authorization: `Bearer ${user.token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Response bodies are untyped JSON in tests.
  return { status: response.status, body: (await response.json()) as { [key: string]: any } };
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

async function createTicket(user: TestUser, title = 'Chamado de teste'): Promise<string> {
  const { status, body } = await api('POST', '/tickets', user, {
    title,
    description: 'Descrição do chamado de teste.',
    category: 'software',
  });
  assert.equal(status, 201);
  return body.ticket.id;
}

const listTotal = async (user: TestUser, query = '') =>
  (await api('GET', `/tickets${query}`, user)).body.pagination.total as number;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);

  requester = await createUser('Requester One', 'solicitante');
  otherRequester = await createUser('Requester Two', 'solicitante');
  tech = await createUser('Tech One', 'ti');
  otherTech = await createUser('Tech Two', 'ti');
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

describe('permission map (can)', () => {
  const expected: Record<UserRole, Record<Permission, boolean>> = {
    solicitante: {
      'tickets:view-all': false,
      'tickets:view-audit': false,
      'tickets:operate': false,
      'tickets:be-assigned': false,
      'users:list-it-staff': false,
      'incidents:manage': false,
      'incidents:follow': true,
      'kb:read': true,
      'kb:manage': false,
    },
    ti: {
      'tickets:view-all': true,
      'tickets:view-audit': true,
      'tickets:operate': true,
      'tickets:be-assigned': true,
      'users:list-it-staff': true,
      'incidents:manage': true,
      'incidents:follow': true,
      'kb:read': true,
      'kb:manage': true,
    },
    gestor: {
      'tickets:view-all': true,
      'tickets:view-audit': true,
      'tickets:operate': true,
      'tickets:be-assigned': true,
      'users:list-it-staff': true,
      'incidents:manage': true,
      'incidents:follow': true,
      'kb:read': true,
      'kb:manage': true,
    },
  };

  it('grants exactly the expected permissions to each role', () => {
    for (const [role, permissions] of Object.entries(expected)) {
      for (const [permission, allowed] of Object.entries(permissions)) {
        assert.equal(can(role as UserRole, permission as Permission), allowed, `${role} ${permission}`);
      }
    }
  });

  it('covers every permission in the map', () => {
    assert.deepEqual(Object.keys(expected.ti).sort(), Object.keys(PERMISSIONS).sort());
  });

  it('denies everything to an unknown role', () => {
    for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
      assert.equal(can('admin' as UserRole, permission), false, permission);
    }
  });
});

describe('route matrix: requester / IT / manager', () => {
  let requesterTicket: string;

  before(async () => {
    requesterTicket = await createTicket(requester, 'Chamado do solicitante');
    await createTicket(otherRequester, 'Chamado de outra pessoa');
  });

  it('POST /tickets: every role can open a ticket, always as its own requester', async () => {
    for (const user of [requester, tech, manager]) {
      const { status, body } = await api('POST', '/tickets', user, {
        title: 'Aberto por qualquer papel',
        description: 'Qualquer colaborador pode abrir chamados.',
        category: 'outros',
        requester: otherRequester.id,
      });
      assert.equal(status, 400, 'requester in the body is still rejected');
      assert.ok(body.formErrors);
    }
    for (const user of [requester, tech, manager]) {
      const id = await createTicket(user, 'Aberto por qualquer papel');
      const { body } = await api('GET', `/tickets/${id}`, user);
      assert.equal(body.ticket.requesterId, user.id);
    }
  });

  it('GET /tickets: requesters see only their own; IT and manager see all', async () => {
    const all = await TicketModel.countDocuments();
    const own = await TicketModel.countDocuments({ requester: requester.id });

    assert.equal(await listTotal(requester), own);
    assert.equal(await listTotal(tech), all);
    assert.equal(await listTotal(manager), all);
  });

  it("GET /tickets/:id of someone else's ticket: 404 / 200 / 200", async () => {
    assert.equal((await api('GET', `/tickets/${requesterTicket}`, otherRequester)).status, 404);
    assert.equal((await api('GET', `/tickets/${requesterTicket}`, tech)).status, 200);
    assert.equal((await api('GET', `/tickets/${requesterTicket}`, manager)).status, 200);
  });

  it('triage (category/priority): 403 / 200 / 200', async () => {
    const change = (user: TestUser) =>
      api('PATCH', `/tickets/${requesterTicket}`, user, { priority: 'alta' });
    assert.equal((await change(requester)).status, 403);
    assert.equal((await change(manager)).status, 200);
    assert.equal((await change(tech)).status, 200);
  });

  it('PATCH /:id/assignee: 403 / 200 / 200', async () => {
    const assign = (user: TestUser) =>
      api('PATCH', `/tickets/${requesterTicket}/assignee`, user, { assigneeId: otherTech.id });
    assert.equal((await assign(requester)).status, 403);
    assert.equal((await assign(manager)).status, 200);
    assert.equal((await assign(tech)).status, 200);
  });

  it('PATCH /:id/status: 403 / 200 / 200', async () => {
    const start = (user: TestUser) =>
      api('PATCH', `/tickets/${requesterTicket}/status`, user, { status: 'em_andamento' });
    assert.equal((await start(requester)).status, 403);
    assert.equal((await start(manager)).status, 200);
    assert.equal((await start(tech)).status, 409);
  });

  it('GET /users/it-staff: 403 / 200 / 200, listing only IT users', async () => {
    assert.equal((await api('GET', '/users/it-staff', requester)).status, 403);

    for (const user of [tech, manager]) {
      const { status, body } = await api('GET', '/users/it-staff', user);
      assert.equal(status, 200);
      assert.deepEqual(
        body.users.map((u: any) => u.name),
        ['Manager One', 'Tech One', 'Tech Two'],
        'operators include the manager',
      );
    }
  });
});

describe('manager-specific rules', () => {
  it('edits the title of their own ticket while it is open', async () => {
    const id = await createTicket(manager, 'Notebook do gestor');
    const { status, body } = await api('PATCH', `/tickets/${id}`, manager, { title: 'Notebook do gestor lento' });

    assert.equal(status, 200);
    const event = body.ticket.history.at(-1);
    assert.equal(event.type, 'updated');
    assert.equal(event.author.id, manager.id);
  });

  it("cannot edit someone else's ticket, even though they can read it", async () => {
    const id = await createTicket(requester, 'Chamado alheio');
    const { status } = await api('PATCH', `/tickets/${id}`, manager, { title: 'Editado pelo gestor' });
    assert.equal(status, 403);
  });

  it('can be assigned as responsible for a ticket', async () => {
    const id = await createTicket(requester, 'Chamado para atribuir');
    const { status, body } = await api('PATCH', `/tickets/${id}/assignee`, tech, { assigneeId: manager.id });

    assert.equal(status, 200);
    assert.equal(body.ticket.assignee.id, manager.id);
  });

  it('starts work and is auto-assigned as authenticated operator', async () => {
    const id = await createTicket(requester, 'Chamado sem atendimento');
    assert.equal((await api('PATCH', `/tickets/${id}/status`, manager, { status: 'em_andamento' })).status, 200);

    const { body } = await api('GET', `/tickets/${id}`, manager);
    assert.equal(body.ticket.status, 'em_andamento');
    assert.equal(body.ticket.assignee.id, manager.id);
    assert.equal(body.ticket.history.length, 3);
    assert.equal(body.ticket.history.at(-1).audit.actorId, manager.id);
  });
});

describe('GET /api/dashboard/summary for the manager', () => {
  it('has global scope, no personal workload, and matches the ticket list', async () => {
    const { status, body } = await api('GET', '/dashboard/summary', manager);
    const { summary } = body;

    assert.equal(status, 200);
    assert.equal(summary.scope, 'all');
    assert.equal('workload' in summary, false);
    assert.equal(summary.byStatus.total, await listTotal(manager));
    for (const ticketStatus of ['aberto', 'em_andamento', 'resolvido']) {
      assert.equal(summary.byStatus[ticketStatus], await listTotal(manager, `?status=${ticketStatus}`), ticketStatus);
    }
  });

  it('IT keeps the personal workload', async () => {
    const { body } = await api('GET', '/dashboard/summary', tech);
    assert.ok(body.summary.workload);
  });
});

describe('the role always comes from the database', () => {
  it('a role change applies to the same token on the next request', async () => {
    const user = await createUser('Promoted User', 'solicitante');
    await createTicket(user, 'Chamado do usuário promovido');

    assert.equal(await listTotal(user), 1);
    assert.equal((await api('GET', '/users/it-staff', user)).status, 403);

    await UserModel.updateOne({ _id: user.id }, { role: 'gestor' });

    assert.equal(await listTotal(user), await TicketModel.countDocuments());
    assert.equal((await api('GET', '/users/it-staff', user)).status, 200);
  });
});

describe('User model roles', () => {
  it('accepts gestor and rejects unknown roles', async () => {
    await assert.doesNotReject(
      UserModel.create({ name: 'Valid', email: 'valid.gestor@test.local', passwordHash: 'x', role: 'gestor' }),
    );
    await assert.rejects(
      UserModel.create({
        name: 'Invalid',
        email: 'invalid.role@test.local',
        passwordHash: 'x',
        // Deliberately invalid value: the cast only bypasses TypeScript so the schema can reject it.
        role: 'admin' as UserRole,
      }),
      (error: Error) => error.name === 'ValidationError',
    );
  });
});
