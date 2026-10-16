import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { AssetModel, ProductModel, StockMovementModel } from '../src/models/inventory.model';
import { DepartmentModel, RoomModel } from '../src/models/organization.model';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// Stock and equipment indicators for management decisions.
const TEST_DB_NAME = 'it-helpdesk-test-inventory-insights';

let server: Server;
let baseUrl: string;
type TestUser = { id: string; token: string };
type Json = { [key: string]: any };
let requester: TestUser, tech: TestUser, demoTech: TestUser, manager: TestUser;

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, role: UserRole, email?: string): Promise<TestUser> {
  const user = await UserModel.create({ name, email: email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@insights.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

const op = () => randomUUID();
const demoMode = env.DEMO_MODE;
let insights: Json;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel, TicketModel, ProductModel, AssetModel, StockMovementModel, DepartmentModel, RoomModel].map((m) => m.syncIndexes()));
  requester = await createUser('Maria Insight', 'solicitante');
  tech = await createUser('Carlos Insight', 'ti');
  // A reserved fictitious account: its movements are demonstration data.
  demoTech = await createUser('Conta demonstrativa', 'ti', 'demo.ti2@helpdesk.local');
  manager = await createUser('Ana Insight', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const finance = (await api('POST', '/organization/departments', manager, { name: 'Financeiro' })).body.department;
  const hr = (await api('POST', '/organization/departments', manager, { name: 'RH' })).body.department;
  const keyboard = (await api('POST', '/inventory/products', tech, { name: 'Teclado K120', type: 'teclado', tracking: 'quantity', minStock: 6 })).body.product;
  const mouse = (await api('POST', '/inventory/products', tech, { name: 'Mouse M90', type: 'mouse', tracking: 'quantity', minStock: 1 })).body.product;
  const monitor = (await api('POST', '/inventory/products', tech, { name: 'Monitor P2422H', type: 'monitor', tracking: 'asset' })).body.product;
  const ticket = (await api('POST', '/tickets', requester, { title: 'Teclado quebrado', description: 'Teclado sem resposta desde cedo.', category: 'hardware' })).body.ticket;
  await api('POST', `/inventory/products/${keyboard.id}/receipts`, tech, { operationId: op(), quantity: 10 });
  await api('POST', `/inventory/products/${mouse.id}/receipts`, tech, { operationId: op(), quantity: 10 });
  await api('POST', `/inventory/products/${keyboard.id}/issues`, tech, { operationId: op(), quantity: 3, departmentId: finance.id, ticketId: ticket.id });
  await api('POST', `/inventory/products/${keyboard.id}/issues`, tech, { operationId: op(), quantity: 2, departmentId: hr.id });
  await api('POST', `/inventory/products/${mouse.id}/issues`, tech, { operationId: op(), quantity: 1, departmentId: hr.id });
  const mistake = await api('POST', `/inventory/products/${mouse.id}/issues`, tech, { operationId: op(), quantity: 4, departmentId: finance.id });
  await api('POST', `/inventory/products/${mouse.id}/reversals`, manager, { operationId: op(), movementId: mistake.body.movement.id, reason: 'Lançamento duplicado' });
  await api('POST', `/inventory/products/${keyboard.id}/returns`, tech, { operationId: op(), quantity: 1, condition: 'defective', ticketId: ticket.id });
  const asset = (await api('POST', '/inventory/assets', tech, { operationId: op(), productId: monitor.id, assetTag: 'MON-01' })).body.asset;
  await api('POST', `/inventory/assets/${asset.id}/maintenance`, tech, { operationId: op(), reason: 'Imagem piscando' });
  await api('POST', '/inventory/assets', tech, { operationId: op(), productId: monitor.id, assetTag: 'MON-02' });
  // Demonstration consumption, kept out of the operational numbers.
  await api('POST', `/inventory/products/${mouse.id}/issues`, demoTech, { operationId: op(), quantity: 2, departmentId: finance.id });
});

afterEach(() => { env.DEMO_MODE = demoMode; });

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('inventory insights', () => {
  it('are for managers only', async () => {
    assert.equal((await api('GET', '/inventory/insights', tech)).status, 403);
    assert.equal((await api('GET', '/inventory/insights', requester)).status, 403);
    const answer = await api('GET', '/inventory/insights?period=month', manager);
    assert.equal(answer.status, 200);
    insights = answer.body.insights;
  });

  it('show what to restock and what is out of use, counting units apart from product types', () => {
    assert.equal(insights.stock.activeProducts, 3);
    assert.equal(insights.stock.unitsAvailable, 5 + 7, 'keyboards 10−5, mice 10−1−2 (the reversed 4 came back)');
    assert.deepEqual(insights.stock.belowMinimum.map((p: Json) => p.name), ['Teclado K120']);
    assert.deepEqual(insights.assets, { in_maintenance: 1, available: 1 });
  });

  it('report operational consumption only, without reversed deliveries', () => {
    assert.equal(insights.origin, 'operational');
    assert.equal(insights.period.deliveredUnits, 6, '3 + 2 keyboards and 1 mouse; the reversed 4 and the demo 2 are out');
    assert.deepEqual(insights.period.topProducts.map((p: Json) => [p.name, p.units]), [['Teclado K120', 5], ['Mouse M90', 1]]);
    assert.deepEqual(insights.period.byDepartment.map((d: Json) => [d.name, d.units]), [['Financeiro', 3], ['RH', 3]]);
    assert.deepEqual(insights.period.defectsByProduct.map((p: Json) => [p.name, p.units]), [['Teclado K120', 1]]);
    assert.equal(insights.period.linkedToTickets, 2);
  });

  it('show demonstration consumption only when asked, and never outside the demonstration mode', async () => {
    env.DEMO_MODE = true;
    const demo = (await api('GET', '/inventory/insights?dataOrigin=demo', manager)).body.insights;
    assert.equal(demo.period.deliveredUnits, 2);
    env.DEMO_MODE = false;
    assert.equal((await api('GET', '/inventory/insights?dataOrigin=demo', manager)).status, 403);
  });
});
