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

// Integration tests: real Express app + real MongoDB, with this file's own database
// (node:test runs test files in parallel).
const TEST_DB_NAME = 'it-helpdesk-test-dashboard';

let server: Server;
let baseUrl: string;

interface TestUser {
  id: string;
  token: string;
}

let requester: TestUser;
let otherRequester: TestUser;
let newcomer: TestUser;
let tech: TestUser;
let otherTech: TestUser;

async function api(method: string, path: string, user?: TestUser, body?: unknown) {
  if (method === 'PATCH' && body && typeof body === 'object' && !('expectedRevision' in body)) {
    const latest = await api('GET', path.replace(/\/(status|assignee)$/, ''), user);
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

async function createTicket(user: TestUser, title: string, category: string, priority: string) {
  const { status, body } = await api('POST', '/tickets', user, {
    title,
    description: `Descrição de ${title}`,
    category,
    priority,
  });
  assert.equal(status, 201);
  return body.ticket.id as string;
}

const setStatus = (id: string, status: string, user: TestUser = tech) =>
  api('PATCH', `/tickets/${id}/status`, user, { status });

const summaryOf = async (user: TestUser) => (await api('GET', '/dashboard/summary', user)).body.summary;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);

  requester = await createUser('Requester One', 'solicitante');
  otherRequester = await createUser('Requester Two', 'solicitante');
  newcomer = await createUser('Requester New', 'solicitante');
  tech = await createUser('Tech One', 'ti');
  otherTech = await createUser('Tech Two', 'ti');

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

  // Requester One (4 tickets)
  await createTicket(requester, 'Impressora parada', 'hardware', 'alta'); // aberto, unassigned
  const vpn = await createTicket(requester, 'VPN sem conexão', 'acesso', 'alta'); // aberto, assigned to Tech Two
  const excel = await createTicket(requester, 'Excel travando', 'software', 'media'); // em_andamento, Tech One
  const mouse = await createTicket(requester, 'Mouse com defeito', 'hardware', 'baixa'); // resolvido
  // Requester Two (2 tickets)
  await createTicket(otherRequester, 'Wi-Fi lento', 'rede', 'media'); // aberto, unassigned
  const email = await createTicket(otherRequester, 'E-mail fora do ar', 'software', 'alta'); // em_andamento, Tech Two

  await api('PATCH', `/tickets/${vpn}/assignee`, tech, { assigneeId: otherTech.id });
  await setStatus(excel, 'em_andamento', tech);
  await setStatus(email, 'em_andamento', otherTech);
  await setStatus(mouse, 'em_andamento', tech);
  await setStatus(mouse, 'resolvido', tech);
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('GET /api/dashboard/summary', () => {
  it('requires authentication', async () => {
    assert.equal((await api('GET', '/dashboard/summary')).status, 401);
  });

  it('rejects query parameters (the scope cannot be changed from the URL)', async () => {
    const { status } = await api('GET', '/dashboard/summary?scope=all', requester);
    assert.equal(status, 400);
  });

  it('IT gets counts for every ticket', async () => {
    const summary = await summaryOf(tech);

    assert.equal(summary.scope, 'all');
    assert.deepEqual(summary.byStatus, { aberto: 3, em_andamento: 2, resolvido: 1, total: 6 });
  });

  it('priority and category distributions only count pending tickets', async () => {
    const summary = await summaryOf(tech);

    // Pending: Impressora (alta, hardware), VPN (alta, acesso), Excel (media, software),
    // Wi-Fi (media, rede), E-mail (alta, software). The resolved "Mouse" is not counted.
    assert.deepEqual(summary.pendingByPriority, { baixa: 0, media: 2, alta: 3 });
    assert.deepEqual(summary.pendingByCategory, {
      hardware: 1,
      software: 2,
      rede: 1,
      acesso: 1,
      outros: 0,
    });
  });

  it('IT workload: unassigned and in progress assigned to me', async () => {
    assert.deepEqual((await summaryOf(tech)).workload, { unassigned: 2, inProgressAssignedToMe: 1 });
    assert.deepEqual((await summaryOf(otherTech)).workload, { unassigned: 2, inProgressAssignedToMe: 1 });
  });

  it('a requester only gets numbers about their own tickets, without the IT workload', async () => {
    const summary = await summaryOf(requester);

    assert.equal(summary.scope, 'mine');
    assert.deepEqual(summary.byStatus, { aberto: 2, em_andamento: 1, resolvido: 1, total: 4 });
    assert.deepEqual(summary.pendingByPriority, { baixa: 0, media: 1, alta: 2 });
    assert.equal(summary.pendingByCategory.rede, 0, 'Wi-Fi belongs to another requester');
    assert.equal('workload' in summary, false);
    assert.ok(summary.recent.every((t: any) => t.requesterId === requester.id));
  });

  it('returns zeros (not missing keys) when there is nothing to count', async () => {
    const summary = await summaryOf(newcomer);

    assert.deepEqual(summary.byStatus, { aberto: 0, em_andamento: 0, resolvido: 0, total: 0 });
    assert.deepEqual(summary.pendingByPriority, { baixa: 0, media: 0, alta: 0 });
    assert.deepEqual(summary.pendingByCategory, { hardware: 0, software: 0, rede: 0, acesso: 0, outros: 0 });
    assert.deepEqual(summary.recent, []);
  });

  it('recent tickets: at most 5, newest first, same as the first page of the list', async () => {
    const summary = await summaryOf(tech);
    const { body } = await api('GET', '/tickets?limit=5', tech);

    assert.equal(summary.recent.length, 5);
    assert.deepEqual(
      summary.recent.map((t: any) => t.id),
      body.tickets.map((t: any) => t.id),
    );
    assert.equal('history' in summary.recent[0], false);
  });

  it('every number matches the ticket list with the equivalent filters', async () => {
    for (const user of [tech, otherTech, requester, otherRequester]) {
      const summary = await summaryOf(user);
      const listTotal = async (query: string) =>
        (await api('GET', `/tickets?${query}`, user)).body.pagination.total;

      assert.equal(summary.byStatus.total, await listTotal(''));
      for (const status of ['aberto', 'em_andamento', 'resolvido']) {
        assert.equal(summary.byStatus[status], await listTotal(`status=${status}`), status);
      }
      if (summary.workload) {
        assert.equal(summary.workload.unassigned, await listTotal('assignee=none'));
        assert.equal(
          summary.workload.inProgressAssignedToMe,
          await listTotal('assignee=me&status=em_andamento'),
        );
      }
    }
  });
});
