import { after, before, describe, it } from 'node:test';
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

// Tickets and materials: where the problem is, what was delivered and who did each thing.
const TEST_DB_NAME = 'it-helpdesk-test-inventory-tickets';

let server: Server;
let baseUrl: string;
type TestUser = { id: string; token: string };
type Json = { [key: string]: any };
let maria: TestUser, other: TestUser, carlos: TestUser, joao: TestUser, ana: TestUser;
let finance: Json, room203: Json, hr: Json, keyboard: Json, notebook: Json;

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@tickets-stock.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

const op = () => randomUUID();
const revisionOf = async (id: string) => (await api('GET', `/tickets/${id}`, carlos)).body.ticket.revision;
const openTicket = async (user: TestUser, extra: Json = {}) => {
  const created = await api('POST', '/tickets', user, { title: 'Teclado parou de funcionar', description: 'Metade das teclas não responde desde cedo.', category: 'hardware', ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.ticket as Json;
};
const available = async (productId: string) => (await api('GET', `/inventory/products/${productId}`, carlos)).body.product.stock.available;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel, TicketModel, ProductModel, AssetModel, StockMovementModel, DepartmentModel, RoomModel].map((m) => m.syncIndexes()));
  maria = await createUser('Maria Oliveira', 'solicitante');
  other = await createUser('Paulo Outro', 'solicitante');
  carlos = await createUser('Carlos Andrade', 'ti');
  joao = await createUser('Joao Silva', 'ti');
  ana = await createUser('Ana Ribeiro', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  finance = (await api('POST', '/organization/departments', ana, { name: 'Financeiro' })).body.department;
  room203 = (await api('POST', '/organization/rooms', ana, { departmentId: finance.id, name: 'Sala 203' })).body.room;
  hr = (await api('POST', '/organization/departments', ana, { name: 'RH' })).body.department;
  keyboard = (await api('POST', '/inventory/products', carlos, { name: 'Teclado Logitech K120', type: 'teclado', brand: 'Logitech', model: 'K120', tracking: 'quantity', attributes: { layout: 'ABNT2' } })).body.product;
  notebook = (await api('POST', '/inventory/products', carlos, { name: 'Notebook Dell Latitude', type: 'notebook', tracking: 'asset' })).body.product;
  await api('POST', `/inventory/products/${keyboard.id}/receipts`, carlos, { operationId: op(), quantity: 5 });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('where the problem is', () => {
  it('the requester says the department and room; the ticket keeps them as named at the time', async () => {
    const ticket = await openTicket(maria, { location: { departmentId: finance.id, roomId: room203.id } });
    assert.deepEqual(ticket.location, { department: { id: finance.id, name: 'Financeiro' }, room: { id: room203.id, name: 'Sala 203' } });
    await api('PATCH', `/organization/rooms/${room203.id}`, ana, { name: 'Sala 203-A' });
    assert.equal((await api('GET', `/tickets/${ticket.id}`, maria)).body.ticket.location.room.name, 'Sala 203', 'history keeps the original place');
    await api('PATCH', `/organization/rooms/${room203.id}`, ana, { name: 'Sala 203' });
  });

  it('references are validated, and tickets without a place keep working', async () => {
    assert.equal((await api('POST', '/tickets', maria, { title: 'Teclado com defeito', description: 'Teclas sem resposta nenhuma.', category: 'hardware', location: { departmentId: hr.id, roomId: room203.id } })).status, 400);
    assert.equal((await api('POST', '/tickets', maria, { title: 'Teclado com defeito', description: 'Teclas sem resposta nenhuma.', category: 'hardware', location: { departmentId: '0123456789abcdef01234567' } })).status, 400);
    const plain = await openTicket(maria);
    assert.equal(plain.location, null);
  });

  it('a requester may point only to equipment they hold', async () => {
    const mine = (await api('POST', '/inventory/assets', carlos, { operationId: op(), productId: notebook.id, assetTag: 'NB-0001', status: 'in_use', departmentId: finance.id, roomId: room203.id, holderId: maria.id })).body.asset;
    const theirs = (await api('POST', '/inventory/assets', carlos, { operationId: op(), productId: notebook.id, assetTag: 'NB-0002', status: 'in_use', departmentId: hr.id, holderId: other.id })).body.asset;
    const ticket = await openTicket(maria, { affectedAssetId: mine.id });
    assert.deepEqual(ticket.affectedAsset, { assetTag: 'NB-0001', name: 'Notebook Dell Latitude' });
    assert.equal((await api('POST', '/tickets', maria, { title: 'Notebook lento', description: 'O notebook está muito lento.', category: 'hardware', affectedAssetId: theirs.id })).status, 400);
  });
});

describe('delivering material for a ticket', () => {
  it('the delivery takes exactly one unit, records who did it and never changes the ticket', async () => {
    const ticket = await openTicket(maria, { location: { departmentId: finance.id, roomId: room203.id } });
    await api('PATCH', `/tickets/${ticket.id}/status`, carlos, { status: 'em_andamento', expectedRevision: await revisionOf(ticket.id) });
    const before = await TicketModel.findById(ticket.id).lean();
    const stock = await available(keyboard.id);
    const delivered = await api('POST', `/inventory/products/${keyboard.id}/issues`, joao, {
      operationId: op(), quantity: 1, ticketId: ticket.id, recipientId: maria.id, departmentId: finance.id, roomId: room203.id, reason: 'Substituição do teclado com defeito',
    });
    assert.equal(delivered.status, 201);
    assert.equal(await available(keyboard.id), stock - 1);
    const movement = delivered.body.movement;
    assert.equal(movement.actor.name, 'Joao Silva', 'who registered the delivery');
    assert.equal(movement.recipient.name, 'Maria Oliveira', 'who received it');
    assert.equal(movement.location.room.name, 'Sala 203');
    assert.equal(movement.ticket.id, ticket.id);
    const after = await TicketModel.findById(ticket.id).lean();
    assert.equal(after!.status, 'em_andamento', 'delivering does not resolve');
    assert.equal(after!.revision, before!.revision, 'the ticket itself is untouched');
    assert.equal(String(after!.assignee), carlos.id, 'the assignee stays the assignee');
  });

  it('resolving a ticket never takes anything from the stock', async () => {
    const ticket = await openTicket(maria);
    const stock = await available(keyboard.id);
    const movements = await StockMovementModel.countDocuments();
    await api('PATCH', `/tickets/${ticket.id}/status`, carlos, { status: 'em_andamento', expectedRevision: await revisionOf(ticket.id) });
    await api('PATCH', `/tickets/${ticket.id}/status`, carlos, { status: 'resolvido', expectedRevision: await revisionOf(ticket.id) });
    assert.equal(await available(keyboard.id), stock);
    assert.equal(await StockMovementModel.countDocuments(), movements);
  });

  it('an equipment swap records the new asset delivered and the old one taken back as defective', async () => {
    const old = (await api('POST', '/inventory/assets', carlos, { operationId: op(), productId: notebook.id, assetTag: 'NB-0100', status: 'in_use', departmentId: finance.id, roomId: room203.id, holderId: maria.id })).body.asset;
    const spare = (await api('POST', '/inventory/assets', carlos, { operationId: op(), productId: notebook.id, assetTag: 'NB-0101' })).body.asset;
    const ticket = await openTicket(maria, { affectedAssetId: old.id, location: { departmentId: finance.id, roomId: room203.id } });
    const given = await api('POST', `/inventory/assets/${spare.id}/assign`, carlos, { operationId: op(), ticketId: ticket.id, holderId: maria.id, departmentId: finance.id, roomId: room203.id, reason: 'Troca do notebook' });
    const taken = await api('POST', `/inventory/assets/${old.id}/defective`, carlos, { operationId: op(), ticketId: ticket.id, reason: 'Não liga mais' });
    assert.equal(given.body.asset.status, 'in_use');
    assert.equal(taken.body.asset.status, 'defective');
    assert.equal(taken.body.movement.fromLocation.room.name, 'Sala 203', 'where the broken unit was');
    // A plain keyboard has no identity: what came back is recorded without inventing one.
    const broken = await api('POST', `/inventory/products/${keyboard.id}/returns`, carlos, { operationId: op(), quantity: 1, condition: 'defective', ticketId: ticket.id, recipientId: maria.id, reason: 'Teclado antigo sem resposta' });
    assert.equal(broken.body.movement.asset, null);

    const team = (await api('GET', `/tickets/${ticket.id}/materials`, carlos)).body.materials;
    assert.equal(team.view, 'team');
    assert.deepEqual(team.movements.map((m: Json) => m.type), ['asset_assign', 'asset_defective', 'return']);
  });
});

describe('what the requester sees', () => {
  it('only what was delivered for their own request, without stock levels or other people\'s assets', async () => {
    const ticket = await openTicket(maria);
    await api('POST', `/inventory/products/${keyboard.id}/issues`, carlos, { operationId: op(), quantity: 1, ticketId: ticket.id, recipientId: maria.id });
    const wrong = await api('POST', `/inventory/products/${keyboard.id}/issues`, carlos, { operationId: op(), quantity: 1, ticketId: ticket.id, recipientId: maria.id });
    await api('POST', `/inventory/products/${keyboard.id}/reversals`, ana, { operationId: op(), movementId: wrong.body.movement.id, reason: 'Entrega lançada em duplicidade' });
    const spare = (await api('POST', '/inventory/assets', carlos, { operationId: op(), productId: notebook.id, assetTag: 'NB-0200' })).body.asset;
    await api('POST', `/inventory/assets/${spare.id}/assign`, carlos, { operationId: op(), ticketId: ticket.id, holderId: maria.id, departmentId: finance.id });

    const seen = await api('GET', `/tickets/${ticket.id}/materials`, maria);
    assert.equal(seen.status, 200);
    const { materials } = seen.body;
    assert.equal(materials.view, 'requester');
    assert.equal(materials.deliveries.length, 2, 'a reversed delivery is not shown');
    for (const delivery of materials.deliveries) {
      assert.deepEqual(Object.keys(delivery).sort(), ['assetTag', 'deliveredAt', 'deliveredBy', 'id', 'location', 'product', 'quantity', 'receivedByYou']);
      assert.deepEqual(Object.keys(delivery.deliveredBy), ['name']);
    }
    assert.equal(materials.deliveries.find((d: Json) => d.assetTag)?.assetTag, 'NB-0200', 'their own equipment shows its tag');
    assert.ok(!JSON.stringify(materials).includes('onHand'), 'no stock levels');
    assert.equal((await api('GET', `/tickets/${ticket.id}/materials`, other)).status, 404, 'someone else\'s ticket');
  });
});
