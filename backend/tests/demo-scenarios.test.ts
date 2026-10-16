import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { IncidentParticipationModel, SharedIncidentModel } from '../src/models/incident.model';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, toPublicUser, type UserRole } from '../src/models/user.model';
import { DEMO_SCENARIOS, createDemoScenarios, type DemoPeople } from '../src/services/demo-scenarios';

// The fictitious scenarios used for demos and documentation screenshots.
const TEST_DB_NAME = 'it-helpdesk-test-demo-scenarios';

const createUser = async (name: string, email: string, role: UserRole) =>
  toPublicUser(await UserModel.create({ name, email, passwordHash: 'not-used', role }));

let people: DemoPeople;
const byTitle = (title: string) => TicketModel.findOne({ title }).lean();

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);
  people = {
    requester: await createUser('Mariana Souza', 'solicitante@helpdesk.local', 'solicitante'),
    tech: await createUser('Carlos Andrade', 'ti@helpdesk.local', 'ti'),
  };
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('demo scenarios', () => {
  it('creates only the scenarios whose demo accounts exist', async () => {
    const result = await createDemoScenarios(people);
    assert.equal(result.created.length, 5);
    assert.equal(result.skipped.length, DEMO_SCENARIOS.length - 5);
    assert.equal(await TicketModel.countDocuments(), 5);
    assert.equal(await TicketModel.countDocuments({ dataOrigin: 'demo' }), 5, 'scenarios are demonstration data');
  });

  it('runs every step through the real workflow', async () => {
    const awaiting = await byTitle('Erro ao iniciar o aplicativo de notas fiscais');
    assert.equal(awaiting?.status, 'resolvido');
    assert.ok(!awaiting?.history.some((event) => event.type === 'resolution_confirmed'), 'still waiting for the requester');

    const confirmed = await byTitle('Monitor da estação 12 sem imagem');
    assert.deepEqual(confirmed?.history.map((event) => event.type).slice(-2), ['resolution_confirmed', 'resolution_rated']);

    const contested = await byTitle('Notebook desligando sozinho durante reuniões');
    assert.equal(contested?.status, 'em_andamento');
    assert.equal(contested?.activeCycleId, 2);
    assert.equal(contested?.history.at(-1)?.type, 'reopened');

    const open = await byTitle('Solicitação de acesso ao sistema interno de compras');
    assert.equal(open?.status, 'aberto');
    assert.equal(open?.assignee, null);
    assert.ok(open?.intake?.answers.length, 'guided answers are kept');
  });

  it('adds the team scenarios when the extra accounts exist and keeps what already exists', async () => {
    people.requester2 = await createUser('Maria Oliveira', 'demo.solicitante2@helpdesk.local', 'solicitante');
    people.tech2 = await createUser('João Silva', 'demo.ti2@helpdesk.local', 'ti');
    const before = await TicketModel.find().select('revision').lean();

    const result = await createDemoScenarios(people);
    assert.equal(result.kept.length, 5);
    assert.equal(result.created.length, DEMO_SCENARIOS.length - 5);
    for (const ticket of before) {
      assert.equal((await TicketModel.findById(ticket._id).lean())?.revision, ticket.revision, 'existing tickets are not changed');
    }

    const crossResolved = await byTitle('Planilha de custos não abre no Excel');
    assert.equal(String(crossResolved?.assignee), people.tech2.id);
    assert.equal(String(crossResolved?.resolvedBy), people.tech.id, 'resolved by someone other than the assignee');

    const incident = await SharedIncidentModel.findOne({ status: 'active' }).lean();
    assert.equal(incident?.title, 'Rede cabeada fora do ar no 2º andar');
    assert.equal(await IncidentParticipationModel.countDocuments({ incident: incident?._id, leftAt: null }), 2);
  });

  it('is idempotent', async () => {
    const count = await TicketModel.countDocuments();
    const result = await createDemoScenarios(people);
    assert.equal(result.created.length, 0);
    assert.equal(result.kept.length, DEMO_SCENARIOS.length);
    assert.equal(await TicketModel.countDocuments(), count);
    assert.equal(await SharedIncidentModel.countDocuments(), 1);
  });
});
