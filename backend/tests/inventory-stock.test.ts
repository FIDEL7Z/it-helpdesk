import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { AssetModel, ProductModel, StockMovementModel } from '../src/models/inventory.model';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// Catalog and stock counted by quantity: the ledger, its balances and its guarantees.
const TEST_DB_NAME = 'it-helpdesk-test-inventory-stock';

let server: Server;
let baseUrl: string;
type TestUser = { id: string; token: string };
type Json = { [key: string]: any };
let requester: TestUser, tech: TestUser, otherTech: TestUser, manager: TestUser;

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@stock.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

const op = () => randomUUID();
const keyboard = { name: 'Teclado Logitech K120', type: 'teclado', brand: 'Logitech', model: 'K120', sku: 'tec-k120', tracking: 'quantity', minStock: 3, attributes: { layout: 'ABNT2', connection: 'USB', wireless: false } };
const newProduct = async (fields: Json = {}) => {
  const created = await api('POST', '/inventory/products', tech, { ...keyboard, sku: `SKU-${randomUUID().slice(0, 8)}`, ...fields });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.product as Json;
};
const levels = async (id: string) => (await api('GET', `/inventory/products/${id}`, tech)).body.product.stock as Json;
const ledger = (product: string) => StockMovementModel.find({ product }).sort({ sequence: 1 }).lean();
let ticketId: string;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes(), ProductModel.syncIndexes(), AssetModel.syncIndexes(), StockMovementModel.syncIndexes()]);
  requester = await createUser('Maria Estoque', 'solicitante');
  tech = await createUser('Carlos Estoque', 'ti');
  otherTech = await createUser('Joao Estoque', 'ti');
  manager = await createUser('Ana Estoque', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ticket = await api('POST', '/tickets', requester, { title: 'Teclado parou de funcionar', description: 'Várias teclas não respondem desde hoje cedo.', category: 'hardware' });
  ticketId = ticket.body.ticket.id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('catalog', () => {
  it('IT registers products with type, brand, model and validated characteristics', async () => {
    const created = await api('POST', '/inventory/products', tech, keyboard);
    assert.equal(created.status, 201);
    assert.equal(created.body.product.sku, 'TEC-K120');
    assert.deepEqual(created.body.product.attributes, { layout: 'ABNT2', connection: 'USB', wireless: false });
    assert.deepEqual(created.body.product.stock, { onHand: 0, reserved: 0, available: 0, defective: 0 });
    assert.equal(created.body.product.belowMinimum, true, 'zero units against a minimum of 3');
    assert.equal((await api('POST', '/inventory/products', tech, { ...keyboard, name: 'Outro', sku: 'TEC-k120' })).status, 409, 'SKU is unique, without case');
    assert.equal((await api('POST', '/inventory/products', tech, { ...keyboard, sku: null, type: 'impressora3d' })).status, 400);
    assert.equal((await api('POST', '/inventory/products', tech, { ...keyboard, sku: null, attributes: { layout: 'QWERTZ' } })).status, 400, 'value outside the options');
    assert.equal((await api('POST', '/inventory/products', tech, { ...keyboard, sku: null, attributes: { dpi: 800 } })).status, 400, 'characteristic of another type');
    assert.equal((await api('POST', '/inventory/products', tech, { ...keyboard, sku: null, type: 'monitor', attributes: { sizeInches: 300 } })).status, 400, 'out of range');
    assert.equal((await api('POST', '/inventory/products', tech, { ...keyboard, sku: null, tracking: 'asset', unit: 'metro' })).status, 400);
    assert.equal((await api('POST', '/inventory/products', requester, keyboard)).status, 403);
    assert.equal((await api('GET', '/inventory/products', requester)).status, 403, 'requesters do not see the stock');
  });

  it('searches by name, brand or model and filters by type; edits keep type and tracking fixed', async () => {
    const mouse = await newProduct({ name: 'Mouse Logitech M90', type: 'mouse', model: 'M90', attributes: { connection: 'USB' } });
    const found = (await api('GET', '/inventory/products?q=m90', tech)).body.products.map((p: Json) => p.id);
    assert.deepEqual(found, [mouse.id]);
    assert.ok((await api('GET', '/inventory/products?type=mouse', tech)).body.products.every((p: Json) => p.type === 'mouse'));
    assert.equal((await api('PATCH', `/inventory/products/${mouse.id}`, tech, { tracking: 'asset', expectedRevision: 0 })).status, 400);
    const edited = await api('PATCH', `/inventory/products/${mouse.id}`, tech, { minStock: 5, expectedRevision: 0 });
    assert.equal(edited.status, 200);
    assert.equal((await api('PATCH', `/inventory/products/${mouse.id}`, tech, { minStock: 6, expectedRevision: 0 })).status, 409, 'stale revision');
    assert.equal((await api('PATCH', `/inventory/products/${mouse.id}`, tech, { active: false, expectedRevision: 1 })).status, 200);
    const receipt = await api('POST', `/inventory/products/${mouse.id}/receipts`, tech, { operationId: op(), quantity: 1 });
    assert.equal(receipt.status, 409);
    assert.equal(receipt.body.code, 'PRODUCT_INACTIVE');
    assert.ok((await api('GET', '/inventory/products?status=inactive', tech)).body.products.some((p: Json) => p.id === mouse.id));
  });
});

describe('stock movements', () => {
  it('receipt, reservation, delivery, return and cancellation keep onHand, reserved and available right', async () => {
    const product = await newProduct();
    const r1 = await api('POST', `/inventory/products/${product.id}/receipts`, tech, { operationId: op(), quantity: 5, reason: 'Compra de reposição' });
    assert.equal(r1.status, 201);
    assert.deepEqual(r1.body.product.stock, { onHand: 5, reserved: 0, available: 5, defective: 0 });
    assert.equal(r1.body.movement.actor.id, tech.id, 'author from the token');

    const reservation = await api('POST', `/inventory/products/${product.id}/reservations`, tech, { operationId: op(), quantity: 2, ticketId });
    assert.equal(reservation.status, 201);
    assert.deepEqual(reservation.body.product.stock, { onHand: 5, reserved: 2, available: 3, defective: 0 }, 'a reservation is not a physical exit');
    assert.equal((await api('POST', `/inventory/products/${product.id}/reservations`, tech, { operationId: op(), quantity: 1 })).status, 400, 'a reservation is for a ticket');

    const tooMany = await api('POST', `/inventory/products/${product.id}/issues`, tech, { operationId: op(), quantity: 4 });
    assert.equal(tooMany.status, 409, 'deliveries respect reservations');
    assert.equal(tooMany.body.code, 'INSUFFICIENT_STOCK');

    const fromReservation = await api('POST', `/inventory/products/${product.id}/issues`, otherTech, { operationId: op(), quantity: 2, reservationId: reservation.body.movement.id, ticketId });
    assert.equal(fromReservation.status, 201);
    assert.deepEqual(fromReservation.body.product.stock, { onHand: 3, reserved: 0, available: 3, defective: 0 });
    assert.equal(fromReservation.body.movement.actor.id, otherTech.id, 'the delivery belongs to who registered it');
    const again = await api('POST', `/inventory/products/${product.id}/reservations/${reservation.body.movement.id}/cancel`, tech, { operationId: op() });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'RESERVATION_CLOSED');

    const held = await api('POST', `/inventory/products/${product.id}/reservations`, tech, { operationId: op(), quantity: 1, ticketId });
    const cancelled = await api('POST', `/inventory/products/${product.id}/reservations/${held.body.movement.id}/cancel`, tech, { operationId: op(), reason: 'Usuário não precisou' });
    assert.equal(cancelled.status, 201);
    assert.deepEqual(cancelled.body.product.stock, { onHand: 3, reserved: 0, available: 3, defective: 0 });

    const good = await api('POST', `/inventory/products/${product.id}/returns`, tech, { operationId: op(), quantity: 1, condition: 'good' });
    const broken = await api('POST', `/inventory/products/${product.id}/returns`, tech, { operationId: op(), quantity: 1, condition: 'defective', reason: 'Teclas sem resposta' });
    assert.equal(good.status, 201);
    assert.deepEqual(broken.body.product.stock, { onHand: 4, reserved: 0, available: 4, defective: 1 }, 'broken units are kept apart, never available');
  });

  it('never goes below zero: a delivery above the balance is refused and nothing is recorded', async () => {
    const product = await newProduct();
    await api('POST', `/inventory/products/${product.id}/receipts`, tech, { operationId: op(), quantity: 2 });
    const count = (await ledger(product.id)).length;
    const refused = await api('POST', `/inventory/products/${product.id}/issues`, tech, { operationId: op(), quantity: 5 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'INSUFFICIENT_STOCK');
    assert.equal((await ledger(product.id)).length, count);
    assert.deepEqual(await levels(product.id), { onHand: 2, reserved: 0, available: 2, defective: 0 });
  });

  it('two technicians taking the last mouse at the same time: exactly one delivery', async () => {
    const product = await newProduct({ name: 'Mouse Logitech M170', type: 'mouse', attributes: { wireless: true } });
    await api('POST', `/inventory/products/${product.id}/receipts`, tech, { operationId: op(), quantity: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => api('POST', `/inventory/products/${product.id}/issues`, i % 2 ? tech : otherTech, { operationId: op(), quantity: 1 })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    for (const refused of results.filter((r) => r.status !== 201)) {
      assert.equal(refused.status, 409);
      assert.ok(['INSUFFICIENT_STOCK', 'STOCK_BUSY'].includes(refused.body.code), refused.body.code);
    }
    assert.deepEqual(await levels(product.id), { onHand: 0, reserved: 0, available: 0, defective: 0 });
    assert.equal((await ledger(product.id)).filter((m) => m.type === 'issue').length, 1);
  });

  it('a repeated request does not take another unit; a reused key with other content is refused', async () => {
    const product = await newProduct();
    await api('POST', `/inventory/products/${product.id}/receipts`, tech, { operationId: op(), quantity: 3 });
    const key = op();
    const body = { operationId: key, quantity: 1, ticketId, recipientId: requester.id };
    const first = await api('POST', `/inventory/products/${product.id}/issues`, tech, body);
    const repeated = await api('POST', `/inventory/products/${product.id}/issues`, tech, body);
    assert.equal(first.status, 201);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.replayed, true);
    assert.equal(repeated.body.movement.id, first.body.movement.id);
    assert.deepEqual(await levels(product.id), { onHand: 2, reserved: 0, available: 2, defective: 0 });
    const concurrentKey = op();
    const burst = await Promise.all(Array.from({ length: 6 }, () => api('POST', `/inventory/products/${product.id}/issues`, tech, { operationId: concurrentKey, quantity: 1 })));
    assert.equal(new Set(burst.map((r) => r.body.movement?.id)).size, 1, 'concurrent repeats get the same movement');
    assert.deepEqual(await levels(product.id), { onHand: 1, reserved: 0, available: 1, defective: 0 });
    const reused = await api('POST', `/inventory/products/${product.id}/issues`, tech, { ...body, quantity: 2 });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.code, 'OPERATION_KEY_REUSED');
    assert.equal((await api('POST', `/inventory/products/${product.id}/issues`, otherTech, body)).body.code, 'OPERATION_KEY_REUSED', 'the key belongs to its author');
  });

  it('adjustments, discards and reversals need inventory:adjust and a justification', async () => {
    const product = await newProduct();
    const receipt = await api('POST', `/inventory/products/${product.id}/receipts`, tech, { operationId: op(), quantity: 10 });
    assert.equal((await api('POST', `/inventory/products/${product.id}/adjustments`, tech, { operationId: op(), delta: -1, reason: 'Contagem física' })).status, 403);
    assert.equal((await api('POST', `/inventory/products/${product.id}/adjustments`, manager, { operationId: op(), delta: -1 })).status, 400, 'reason required');
    const adjusted = await api('POST', `/inventory/products/${product.id}/adjustments`, manager, { operationId: op(), delta: -2, reason: 'Contagem física encontrou 8 unidades' });
    assert.equal(adjusted.status, 201);
    assert.equal(adjusted.body.product.stock.onHand, 8);
    await api('POST', `/inventory/products/${product.id}/reservations`, tech, { operationId: op(), quantity: 6, ticketId });
    const below = await api('POST', `/inventory/products/${product.id}/adjustments`, manager, { operationId: op(), delta: -3, reason: 'Contagem física' });
    assert.equal(below.body.code, 'BELOW_RESERVED', 'an adjustment cannot leave fewer units than reserved');

    const reversed = await api('POST', `/inventory/products/${product.id}/reversals`, manager, { operationId: op(), movementId: adjusted.body.movement.id, reason: 'Unidades achadas em outra prateleira' });
    assert.equal(reversed.status, 201);
    assert.equal(reversed.body.product.stock.onHand, 10);
    assert.equal(reversed.body.movement.reverses, adjusted.body.movement.id);
    assert.equal((await api('POST', `/inventory/products/${product.id}/reversals`, manager, { operationId: op(), movementId: adjusted.body.movement.id, reason: 'De novo' })).body.code, 'ALREADY_REVERSED');
    const reservation = (await ledger(product.id)).find((m) => m.type === 'reserve')!;
    assert.equal((await api('POST', `/inventory/products/${product.id}/reversals`, manager, { operationId: op(), movementId: String(reservation._id), reason: 'Tentativa' })).body.code, 'NOT_REVERSIBLE');
    const original = await api('GET', `/inventory/movements/${receipt.body.movement.id}`, manager);
    assert.equal(original.body.movement.quantity, 10, 'the original entry stays as it was');

    await api('POST', `/inventory/products/${product.id}/returns`, tech, { operationId: op(), quantity: 2, condition: 'defective' });
    assert.equal((await api('POST', `/inventory/products/${product.id}/discards`, manager, { operationId: op(), quantity: 3, reason: 'Descarte' })).body.code, 'NEGATIVE_BALANCE');
    assert.equal((await api('POST', `/inventory/products/${product.id}/discards`, manager, { operationId: op(), quantity: 2, reason: 'Descarte para reciclagem' })).body.product.stock.defective, 0);
  });
});

describe('ledger integrity', () => {
  it('each movement records the balance before and after, in an unbroken sequence', async () => {
    const product = await newProduct();
    await api('POST', `/inventory/products/${product.id}/receipts`, tech, { operationId: op(), quantity: 4 });
    await api('POST', `/inventory/products/${product.id}/issues`, tech, { operationId: op(), quantity: 1 });
    await api('POST', `/inventory/products/${product.id}/returns`, tech, { operationId: op(), quantity: 1, condition: 'defective' });
    const rows = await ledger(product.id);
    rows.forEach((row, index) => {
      assert.equal(row.sequence, index + 1);
      if (index) assert.deepEqual(row.before, rows[index - 1].after);
    });
    const stored = await ProductModel.findById(product.id).lean();
    assert.deepEqual({ onHand: stored!.stock.onHand, reserved: stored!.stock.reserved, defective: stored!.stock.defective }, rows.at(-1)!.after);
  });

  it('an interrupted write is repaired from the ledger, which is the source of truth', async () => {
    const product = await newProduct();
    await api('POST', `/inventory/products/${product.id}/receipts`, tech, { operationId: op(), quantity: 3 });
    await ProductModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(product.id) }, { $set: { 'stock.onHand': 0, 'stock.version': 0 } });
    assert.deepEqual(await levels(product.id), { onHand: 3, reserved: 0, available: 3, defective: 0 });
    const next = await api('POST', `/inventory/products/${product.id}/issues`, tech, { operationId: op(), quantity: 3 });
    assert.equal(next.status, 201, 'operations continue from the repaired balance');
  });

  it('history cannot be edited or deleted through the application', async () => {
    const [first] = await StockMovementModel.find().limit(1);
    await assert.rejects(StockMovementModel.updateOne({ _id: first._id }, { $set: { quantity: 999 } }));
    await assert.rejects(StockMovementModel.deleteOne({ _id: first._id }));
  });

  it('movements are listed newest first, filtered and paginated, for the team only', async () => {
    const list = await api('GET', `/inventory/movements?ticketId=${ticketId}&limit=2`, tech);
    assert.equal(list.status, 200);
    assert.equal(list.body.movements.length, 2);
    assert.ok(list.body.pagination.total >= 2);
    assert.ok(list.body.movements.every((m: Json) => m.ticket?.id === ticketId));
    assert.equal((await api('GET', '/inventory/movements', requester)).status, 403);
    assert.equal((await api('GET', '/inventory/movements?type=sale', tech)).status, 400);
  });
});
