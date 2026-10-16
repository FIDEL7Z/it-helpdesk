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

// Equipment tracked one by one: tags, states, places, people and history.
const TEST_DB_NAME = 'it-helpdesk-test-inventory-assets';

let server: Server;
let baseUrl: string;
type TestUser = { id: string; token: string };
type Json = { [key: string]: any };
let requester: TestUser, otherRequester: TestUser, tech: TestUser, otherTech: TestUser, manager: TestUser;
let finance: Json, room203: Json, sales: Json, room205: Json, monitor: Json, ticketId: string;

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@assets.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

const op = () => randomUUID();
let tagCount = 0;
const register = (fields: Json = {}) => api('POST', '/inventory/assets', tech, { operationId: op(), productId: monitor.id, assetTag: `PAT-${String(++tagCount).padStart(4, '0')}`, ...fields });
const act = (assetId: string, action: string, body: Json = {}, user = tech) => api('POST', `/inventory/assets/${assetId}/${action}`, user, { operationId: op(), ...body });

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel, TicketModel, ProductModel, AssetModel, StockMovementModel, DepartmentModel, RoomModel].map((m) => m.syncIndexes()));
  requester = await createUser('Maria Ativo', 'solicitante');
  otherRequester = await createUser('Bruno Ativo', 'solicitante');
  tech = await createUser('Carlos Ativo', 'ti');
  otherTech = await createUser('Joao Ativo', 'ti');
  manager = await createUser('Ana Ativo', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  finance = (await api('POST', '/organization/departments', manager, { name: 'Financeiro' })).body.department;
  room203 = (await api('POST', '/organization/rooms', manager, { departmentId: finance.id, name: 'Sala 203' })).body.room;
  sales = (await api('POST', '/organization/departments', manager, { name: 'Comercial' })).body.department;
  room205 = (await api('POST', '/organization/rooms', manager, { departmentId: sales.id, name: 'Sala 205' })).body.room;
  monitor = (await api('POST', '/inventory/products', tech, { name: 'Monitor Dell P2422H', type: 'monitor', brand: 'Dell', model: 'P2422H', tracking: 'asset', attributes: { sizeInches: 24 } })).body.product;
  ticketId = (await api('POST', '/tickets', requester, { title: 'Monitor piscando', description: 'A imagem pisca o tempo todo desde ontem.', category: 'hardware' })).body.ticket.id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('registering assets', () => {
  it('each unit has a unique asset tag; a serial number is unique per model', async () => {
    const created = await register({ assetTag: 'pat-1001', serialNumber: 'CN-0001' });
    assert.equal(created.status, 201);
    assert.equal(created.body.asset.assetTag, 'PAT-1001');
    assert.equal(created.body.asset.status, 'available');
    assert.equal((await register({ assetTag: 'PAT-1001' })).body.code, 'ASSET_TAG_TAKEN', 'tags are unique without case');
    assert.equal((await register({ serialNumber: 'CN-0001' })).body.code, 'SERIAL_TAKEN');
    const cable = (await api('POST', '/inventory/products', tech, { name: 'Cabo HDMI', type: 'cabo', tracking: 'quantity' })).body.product;
    assert.equal((await register({ productId: cable.id })).body.code, 'TRACKING_MISMATCH', 'quantity products are not tagged one by one');
    assert.equal((await register({ status: 'in_use' })).status, 400, 'in use needs a place');
    assert.equal((await api('POST', '/inventory/assets', requester, { operationId: op(), productId: monitor.id, assetTag: 'PAT-9999' })).status, 403);
  });

  it('repeating a registration returns the same asset instead of creating another', async () => {
    const body = { operationId: op(), productId: monitor.id, assetTag: 'PAT-2001', status: 'in_use', departmentId: finance.id, roomId: room203.id, holderId: requester.id };
    const first = await api('POST', '/inventory/assets', tech, body);
    const repeated = await api('POST', '/inventory/assets', tech, body);
    assert.equal(first.status, 201);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.asset.id, first.body.asset.id);
    assert.equal(await AssetModel.countDocuments({ assetTag: 'PAT-2001' }), 1);
    assert.deepEqual(first.body.asset.location, { department: { id: finance.id, name: 'Financeiro' }, room: { id: room203.id, name: 'Sala 203' } });
    assert.equal(first.body.asset.holder.name, 'Maria Ativo');
  });
});

describe('moving assets', () => {
  it('assign, transfer, maintenance and return follow the allowed transitions and keep the whole history', async () => {
    const asset = (await register()).body.asset;
    assert.equal((await act(asset.id, 'transfer', { departmentId: sales.id })).body.code, 'INVALID_TRANSITION', 'only an asset in use is transferred');
    const assigned = await act(asset.id, 'assign', { departmentId: finance.id, roomId: room203.id, holderId: requester.id, ticketId });
    assert.equal(assigned.status, 201);
    assert.equal(assigned.body.asset.status, 'in_use');
    const moved = await act(asset.id, 'transfer', { departmentId: sales.id, roomId: room205.id, holderId: otherRequester.id, reason: 'Mudança de setor' }, otherTech);
    assert.equal(moved.body.movement.fromLocation.room.name, 'Sala 203', 'where it was stays in the movement');
    assert.equal(moved.body.movement.location.room.name, 'Sala 205');
    assert.equal(moved.body.movement.actor.id, otherTech.id);
    assert.equal((await act(asset.id, 'maintenance')).status, 400, 'maintenance needs a reason');
    const maintenance = await act(asset.id, 'maintenance', { reason: 'Imagem piscando' });
    assert.equal(maintenance.body.asset.status, 'in_maintenance');
    assert.equal(maintenance.body.asset.location, null, 'out of use: no current place or holder');
    assert.equal((await act(asset.id, 'return', { reason: 'Reparo concluído' })).body.asset.status, 'available');
    const detail = await api('GET', `/inventory/assets/${asset.id}`, tech);
    assert.deepEqual(detail.body.history.map((m: Json) => m.type), ['asset_return', 'asset_maintenance', 'asset_transfer', 'asset_assign', 'asset_register']);
    assert.deepEqual(detail.body.history.map((m: Json) => m.sequence), [5, 4, 3, 2, 1]);
  });

  it('a reservation holds the asset for a ticket until delivered or cancelled', async () => {
    const asset = (await register()).body.asset;
    assert.equal((await act(asset.id, 'reserve')).status, 400, 'a reservation is for a ticket');
    const reserved = await act(asset.id, 'reserve', { ticketId });
    assert.equal(reserved.body.asset.status, 'reserved');
    assert.equal(reserved.body.asset.ticket.id, ticketId);
    assert.equal((await act(asset.id, 'cancel-reservation')).body.asset.status, 'available');
  });

  it('two technicians delivering the same asset at once: only one succeeds', async () => {
    const asset = (await register()).body.asset;
    const results = await Promise.all([tech, otherTech, tech, otherTech].map((user) => act(asset.id, 'assign', { departmentId: finance.id, holderId: requester.id }, user)));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.code === 'INVALID_TRANSITION' || r.body.code === 'STOCK_BUSY'));
    assert.equal(await StockMovementModel.countDocuments({ asset: asset.id, type: 'asset_assign' }), 1);
  });

  it('writing off needs inventory:adjust and a reason, and is final; nothing is deleted', async () => {
    const asset = (await register()).body.asset;
    await act(asset.id, 'defective', { reason: 'Tela quebrada' });
    assert.equal((await act(asset.id, 'retire', { reason: 'Sem conserto' })).status, 403, 'IT cannot write off');
    assert.equal((await act(asset.id, 'retire', {}, manager)).status, 400);
    const retired = await act(asset.id, 'retire', { reason: 'Sem conserto viável' }, manager);
    assert.equal(retired.body.asset.status, 'retired');
    assert.equal((await act(asset.id, 'return', {}, manager)).body.code, 'INVALID_TRANSITION');
    assert.ok(await AssetModel.exists({ _id: asset.id }));
    assert.equal(await StockMovementModel.countDocuments({ asset: asset.id }), 3);
  });
});

describe('reading assets', () => {
  it('the team filters by status, department and holder; requesters see only their own equipment', async () => {
    const inFinance = await api('GET', `/inventory/assets?departmentId=${finance.id}&status=in_use`, tech);
    assert.ok(inFinance.body.assets.length >= 1);
    assert.ok(inFinance.body.assets.every((a: Json) => a.location.department.id === finance.id && a.status === 'in_use'));
    assert.equal((await api('GET', '/inventory/assets', requester)).status, 403);
    const mine = (await api('GET', '/inventory/assets/mine', requester)).body.assets;
    assert.ok(mine.length >= 1);
    assert.deepEqual(Object.keys(mine[0]).sort(), ['assetTag', 'id', 'name', 'type']);
    const theirs = (await api('GET', '/inventory/assets/mine', otherRequester)).body.assets.map((a: Json) => a.id);
    assert.ok(mine.every((a: Json) => !theirs.includes(a.id)));
  });
});
