import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { AssetModel, ProductModel, StockMovementModel } from '../src/models/inventory.model';
import { DepartmentModel, RoomModel } from '../src/models/organization.model';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, toPublicUser, type UserRole } from '../src/models/user.model';
import { seedDemoInventory, type InventoryPeople } from '../src/services/demo-inventory';

// The fictitious company used for demos and screenshots.
const TEST_DB_NAME = 'it-helpdesk-test-demo-inventory';

const createUser = async (name: string, email: string, role: UserRole) => toPublicUser(await UserModel.create({ name, email, passwordHash: 'not-used', role }));
let people: InventoryPeople;
let firstLog: string[];

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel, TicketModel, ProductModel, AssetModel, StockMovementModel, DepartmentModel, RoomModel].map((m) => m.syncIndexes()));
  people = {
    requester: await createUser('Mariana Souza', 'solicitante@helpdesk.local', 'solicitante'),
    requester2: await createUser('Maria Oliveira', 'demo.solicitante2@helpdesk.local', 'solicitante'),
    tech: await createUser('Carlos Andrade', 'ti@helpdesk.local', 'ti'),
    tech2: await createUser('João Silva', 'demo.ti2@helpdesk.local', 'ti'),
    manager: await createUser('Ana Ribeiro', 'gestor@helpdesk.local', 'gestor'),
  };
  firstLog = await seedDemoInventory(people);
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const stockOf = async (sku: string) => (await ProductModel.findOne({ sku }).lean())!.stock;

describe('demo inventory', () => {
  it('builds the company, the catalog and the tagged equipment', async () => {
    assert.equal(await DepartmentModel.countDocuments(), 5);
    assert.equal(await RoomModel.countDocuments(), 5);
    assert.equal(await ProductModel.countDocuments(), 9);
    assert.equal(await AssetModel.countDocuments(), 5);
    const maria = await UserModel.findById(people.requester2!.id).lean();
    const finance = await DepartmentModel.findOne({ name: 'Financeiro' }).lean();
    assert.equal(String(maria!.department), String(finance!._id), 'Maria works in Finance');
  });

  it('runs the scenarios through the real rules', async () => {
    assert.deepEqual(await stockOf('TEC-K120'), { onHand: 5, reserved: 0, defective: 1, version: 3 }, 'one keyboard delivered and the old one kept as defective');
    assert.equal((await stockOf('MOU-M90')).onHand, 7);
    assert.equal((await stockOf('SSD-KNG-480')).onHand, 2, 'the delivery above the balance was refused');
    assert.ok(firstLog.some((line) => line.includes('recusada')));
    const monitor = await AssetModel.findOne({ assetTag: 'PAT-0002' }).lean();
    assert.equal(monitor!.status, 'in_maintenance');
    const notebook = await AssetModel.findOne({ assetTag: 'PAT-0003' }).lean();
    assert.equal(notebook!.location!.departmentName, 'Comercial');
    const ticket = await TicketModel.findOne({ title: 'Teclado parou de funcionar' }).lean();
    assert.equal(ticket!.location!.roomName, 'Sala 203');
    assert.equal(ticket!.status, 'em_andamento', 'delivering did not resolve the ticket');
    assert.equal(await StockMovementModel.countDocuments({ ticket: ticket!._id }), 2);
    assert.ok((await StockMovementModel.find()).every((m) => m.dataOrigin === 'demo'));
  });

  it('is idempotent: a second run changes nothing', async () => {
    const counts = async () => Promise.all([DepartmentModel, RoomModel, ProductModel, AssetModel, StockMovementModel, TicketModel].map((m) => (m as typeof TicketModel).countDocuments()));
    const before = await counts();
    const log = await seedDemoInventory(people);
    assert.deepEqual(log.filter((line) => !line.includes('recusada')), []);
    assert.deepEqual(await counts(), before);
  });

  it('refuses accounts that are not the reserved demo ones', async () => {
    const real = await createUser('Pessoa Real', 'pessoa@empresa.test', 'ti');
    await assert.rejects(seedDemoInventory({ ...people, tech: real }), /reserved demo accounts/);
  });
});
