import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { KnowledgeArticleModel } from '../src/models/article.model';
import { SharedIncidentModel } from '../src/models/incident.model';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// Guided request form: subject -> category, contextual answers, article and incident context.
const TEST_DB_NAME = 'it-helpdesk-test-intake';
const DESCRIPTION = 'Desde hoje cedo a internet cai a cada poucos minutos na sala 3.';

let server: Server;
let baseUrl: string;

interface TestUser { id: string; token: string }
let requester: TestUser;
let otherRequester: TestUser;
let tech: TestUser;

type Json = { [key: string]: any };

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@intake.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

const networkTicket = (intake?: Json, overrides: Json = {}) => ({
  title: 'Internet caindo na sala 3', description: DESCRIPTION, category: 'rede', ...(intake && { intake }), ...overrides,
});

const wifiAnswers = [
  { key: 'connection', answer: 'Wi-Fi' },
  { key: 'behavior', answer: 'Está instável ou lenta' },
  { key: 'othersAffected', answer: 'Sim' },
];

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes(), KnowledgeArticleModel.syncIndexes(), SharedIncidentModel.syncIndexes()]);
  requester = await createUser('Rita Pedido', 'solicitante');
  otherRequester = await createUser('Otto Pedido', 'solicitante');
  tech = await createUser('Teo Suporte', 'ti');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('question catalog', () => {
  it('lists questions for the five existing categories; "outros" uses only the free description', async () => {
    const { status, body } = await api('GET', '/tickets/intake-questions', requester);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.questions).sort(), ['acesso', 'hardware', 'outros', 'rede', 'software']);
    assert.deepEqual(body.questions.outros, []);
    assert.equal(body.questions.rede.find((question: Json) => question.key === 'othersAffected').type, 'choice');
  });

  it('never asks for passwords, codes or tokens', async () => {
    const { body } = await api('GET', '/tickets/intake-questions', requester);
    for (const question of Object.values(body.questions).flat() as Json[]) {
      assert.equal(/senha|token|código/i.test(question.label), false, question.label);
    }
  });
});

describe('opening a ticket with guided answers', () => {
  it('stores the answers apart from the untouched description, with the question as asked', async () => {
    const { status, body } = await api('POST', '/tickets', requester, networkTicket({ answers: wifiAnswers }));
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.ticket.description, DESCRIPTION, 'the requester text is kept as written');
    assert.equal(body.ticket.category, 'rede');
    assert.equal(body.ticket.intake.category, 'rede');
    assert.deepEqual(body.ticket.intake.answers.map((item: Json) => [item.key, item.answer]), wifiAnswers.map((item) => [item.key, item.answer]));
    assert.equal(body.ticket.intake.answers[0].question, 'O problema acontece no Wi-Fi ou na conexão por cabo?');
    assert.equal(body.ticket.intake.article, null);
  });

  it('drops blank answers, keeps catalog order and stores nothing when every answer is blank', async () => {
    const partial = await api('POST', '/tickets', requester, networkTicket({ answers: [{ key: 'othersAffected', answer: 'Não' }, { key: 'connection', answer: '   ' }, { key: 'behavior', answer: 'Não funciona' }] }));
    assert.deepEqual(partial.body.ticket.intake.answers.map((item: Json) => item.key), ['behavior', 'othersAffected']);
    const empty = await api('POST', '/tickets', requester, networkTicket({ answers: [{ key: 'connection', answer: '' }] }));
    assert.equal(empty.body.ticket.intake, null);
    assert.equal((await TicketModel.findById(empty.body.ticket.id))?.intake, undefined);
  });

  it('rejects answers that do not belong to the chosen subject or to its options', async () => {
    const cases: Json[] = [
      { answers: [{ key: 'equipment', answer: 'Notebook' }] }, // hardware question on a network ticket
      { answers: [{ key: 'connection', answer: 'Bluetooth' }] }, // not an option
      { answers: [{ key: 'connection', answer: 'Wi-Fi' }, { key: 'connection', answer: 'Cabo' }] }, // repeated
      { answers: [{ key: 'unknown', answer: 'x' }] },
      { answers: [{ key: 'connection', answer: 'Wi-Fi', extra: true }] }, // unknown field
      { answers: [], requester: otherRequester.id },
    ];
    for (const intake of cases) {
      assert.equal((await api('POST', '/tickets', requester, networkTicket(intake))).status, 400, JSON.stringify(intake));
    }
    const longText = await api('POST', '/tickets', requester, {
      title: 'Programa não abre', description: 'O programa de notas fiscais não abre desde ontem.', category: 'software',
      intake: { answers: [{ key: 'program', answer: 'x'.repeat(121) }] },
    });
    assert.equal(longText.status, 400);
    assert.equal(await TicketModel.countDocuments({ title: 'Programa não abre' }), 0);
  });

  it('never sets the priority from the subject', async () => {
    const hardware = await api('POST', '/tickets', requester, {
      title: 'Monitor sem imagem', description: 'O monitor da mesa 4 não mostra imagem.', category: 'hardware',
      intake: { answers: [{ key: 'equipment', answer: 'Monitor' }, { key: 'powersOn', answer: 'Não' }] },
    });
    assert.equal(hardware.body.ticket.priority, 'media', 'default priority, whatever the subject');
    const chosen = await api('POST', '/tickets', requester, networkTicket({ answers: wifiAnswers }, { priority: 'baixa' }));
    assert.equal(chosen.body.ticket.priority, 'baixa', 'the suggested priority is kept as sent');
  });

  it('keeps the help article read before asking, only if it is published', async () => {
    const author = new mongoose.Types.ObjectId(tech.id);
    const base = { summary: 'Resumo do artigo de teste.', category: 'rede' as const, body: 'Conteúdo suficiente para um artigo de teste.', searchText: 'wifi', createdBy: author, updatedBy: author };
    const published = await KnowledgeArticleModel.create({ ...base, title: 'Wi-Fi caindo', status: 'published' as const });
    const draft = await KnowledgeArticleModel.create({ ...base, title: 'Rascunho de rede', status: 'draft' as const });

    const fromArticle = await api('POST', '/tickets', requester, networkTicket({ answers: [], articleId: published.id }));
    assert.deepEqual(fromArticle.body.ticket.intake.article, { id: published.id, title: 'Wi-Fi caindo' });
    assert.deepEqual(fromArticle.body.ticket.intake.answers, []);
    assert.equal((await api('POST', '/tickets', requester, networkTicket({ answers: [], articleId: draft.id }))).status, 400);
  });

  it('tickets without the guided form (older ones) keep working', async () => {
    const plain = await api('POST', '/tickets', requester, networkTicket());
    assert.equal(plain.status, 201);
    assert.equal(plain.body.ticket.intake, null);
    const legacy = await TicketModel.create({ title: 'Chamado antigo', description: 'Aberto antes do formulário guiado.', category: 'outros', requester: requester.id });
    const read = await api('GET', `/tickets/${legacy.id}`, tech);
    assert.equal(read.status, 200);
    assert.equal(read.body.ticket.intake, null);
  });
});

describe('the team reads and corrects the classification', () => {
  it('sees the answers; correcting the category is audited and keeps the subject the requester chose', async () => {
    const created = (await api('POST', '/tickets', requester, networkTicket({ answers: wifiAnswers }))).body.ticket;
    const read = await api('GET', `/tickets/${created.id}`, tech);
    assert.equal(read.body.ticket.intake.answers.length, 3);

    const corrected = await api('PATCH', `/tickets/${created.id}`, tech, { category: 'hardware', expectedRevision: read.body.ticket.revision });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.ticket.category, 'hardware');
    assert.equal(corrected.body.ticket.intake.category, 'rede', 'the original subject stays visible');
    const event = corrected.body.ticket.history.at(-1);
    assert.equal(event.audit.actorId, tech.id);
    assert.deepEqual([event.audit.from.category, event.audit.to.category], ['rede', 'hardware']);
    assert.equal(corrected.body.ticket.priority, read.body.ticket.priority);

    assert.equal((await api('PATCH', `/tickets/${created.id}`, requester, { category: 'rede', expectedRevision: corrected.body.ticket.revision })).status, 403);
    const filtered = await api('GET', '/tickets?category=hardware&search=Internet%20caindo', tech);
    assert.ok(filtered.body.tickets.some((ticket: Json) => ticket.id === created.id), 'the corrected category works in the list filters');
  });

  it('the requester sees their own answers, not other people\'s', async () => {
    const created = (await api('POST', '/tickets', requester, networkTicket({ answers: wifiAnswers }))).body.ticket;
    assert.equal((await api('GET', `/tickets/${created.id}`, requester)).body.ticket.intake.answers.length, 3);
    assert.equal((await api('GET', `/tickets/${created.id}`, otherRequester)).status, 404);
  });
});

describe('related shared incidents', () => {
  it('public incidents carry the subject of the main ticket, so the form can suggest them', async () => {
    const ticket = (await api('POST', '/tickets', otherRequester, networkTicket())).body.ticket;
    const published = await api('POST', `/tickets/${ticket.id}/incident`, tech, {
      title: 'Instabilidade na rede da sala 3', publicMessage: 'A equipe de TI já está verificando a rede da sala 3.',
    });
    assert.equal(published.status, 201);
    const list = await api('GET', '/incidents', requester);
    const incident = list.body.incidents.find((item: Json) => item.id === published.body.incident.id);
    assert.equal(incident.category, 'rede');
    assert.equal('ticketId' in incident, false);
  });
});
