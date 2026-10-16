import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { ArticleFeedbackModel, KnowledgeArticleModel } from '../src/models/article.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// Knowledge base: integration tests with the real Express app and MongoDB, own database.
const TEST_DB_NAME = 'it-helpdesk-test-articles';

let server: Server;
let baseUrl: string;

interface TestUser { id: string; token: string; email: string; name: string }
let requester: TestUser;
let otherRequester: TestUser;
let tech: TestUser;
let manager: TestUser;

type Json = { [key: string]: any };

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json, raw };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@articles.test`;
  const user = await UserModel.create({ name, email, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id), email, name };
}

const article = (overrides: Json = {}) => ({
  title: 'Como reconectar ao Wi-Fi',
  summary: 'Passos rápidos quando a conexão sem fio cai.',
  category: 'rede',
  body: 'Desligue e ligue o Wi-Fi do computador. Depois conecte de novo na rede do escritório.',
  status: 'published',
  ...overrides,
});

async function createArticle(overrides: Json = {}, user: TestUser = tech): Promise<Json> {
  const { status, body } = await api('POST', '/articles', user, article(overrides));
  assert.equal(status, 201, JSON.stringify(body));
  return body.article;
}

const searchTitles = async (query: string, user: TestUser = requester) =>
  (await api('GET', `/articles?${query}`, user)).body.articles.map((item: Json) => item.title);

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), KnowledgeArticleModel.syncIndexes(), ArticleFeedbackModel.syncIndexes()]);
  requester = await createUser('Ana Leitora', 'solicitante');
  otherRequester = await createUser('Bruno Leitor', 'solicitante');
  tech = await createUser('Tales Tecnico', 'ti');
  manager = await createUser('Gabi Gestora', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('writing articles', () => {
  it('only TI and managers create, edit, publish and list every status', async () => {
    assert.equal((await api('POST', '/articles', requester, article())).status, 403);
    assert.equal((await api('GET', '/articles/manage', requester)).status, 403);
    const created = await createArticle({ status: 'draft' });
    assert.equal((await api('PATCH', `/articles/${created.id}`, requester, { status: 'published', expectedRevision: created.revision })).status, 403);

    const published = await api('PATCH', `/articles/${created.id}`, manager, { status: 'published', expectedRevision: created.revision });
    assert.equal(published.status, 200);
    assert.equal(published.body.article.status, 'published');
    assert.equal(published.body.article.createdBy.id, tech.id);
    assert.equal(published.body.article.updatedBy.id, manager.id, 'the last editor is recorded');
    assert.ok(published.body.article.publishedAt);
  });

  it('validates fields; author, dates, counters and search text come from the server', async () => {
    assert.equal((await api('POST', '/articles', tech, article({ title: 'Wi' }))).status, 400);
    assert.equal((await api('POST', '/articles', tech, article({ category: 'impressoras' }))).status, 400);
    assert.equal((await api('POST', '/articles', tech, article({ body: 'curto' }))).status, 400);
    for (const extra of [{ createdBy: requester.id }, { helpfulCount: 99 }, { searchText: 'x' }, { revision: 7 }]) {
      assert.equal((await api('POST', '/articles', tech, { ...article(), ...extra })).status, 400, JSON.stringify(extra));
    }
    const draft = (await api('POST', '/articles', tech, { ...article(), status: undefined })).body.article;
    assert.equal(draft.status, 'draft', 'new articles start as drafts unless published explicitly');
  });

  it('uses the revision: a stale edit gets 409 and saving the same values spends nothing', async () => {
    const created = await createArticle();
    const first = await api('PATCH', `/articles/${created.id}`, tech, { summary: 'Resumo revisado pela equipe de TI.', expectedRevision: created.revision });
    assert.equal(first.status, 200);
    assert.equal(first.body.article.revision, created.revision + 1);
    const stale = await api('PATCH', `/articles/${created.id}`, manager, { summary: 'Outra versão do resumo do artigo.', expectedRevision: created.revision });
    assert.equal(stale.status, 409);
    const same = await api('PATCH', `/articles/${created.id}`, tech, { summary: 'Resumo revisado pela equipe de TI.', expectedRevision: first.body.article.revision });
    assert.equal(same.body.article.revision, first.body.article.revision);
  });

  it('keeps the first publication date when archiving', async () => {
    const created = await createArticle();
    const archived = await api('PATCH', `/articles/${created.id}`, tech, { status: 'archived', expectedRevision: created.revision });
    assert.equal(archived.body.article.status, 'archived');
    assert.equal(archived.body.article.publishedAt, created.publishedAt);
  });
});

describe('reading and searching', () => {
  let draftId: string;
  let archivedId: string;

  before(async () => {
    await KnowledgeArticleModel.deleteMany({});
    await createArticle({ title: 'Impressora não imprime', category: 'hardware', summary: 'O que verificar na impressora parada.', body: 'Confira papel, energia e a fila de impressão do computador.' });
    await createArticle({ title: 'Conexão instável no escritório', summary: 'Quando a rede sem fio oscila.', body: 'Teste em outro dispositivo e aproxime-se do roteador.' });
    await createArticle({ title: 'Programa fecha sozinho', category: 'software', summary: 'Aplicativo trava ou fecha ao abrir.', body: 'Feche o programa, reinicie o computador e anote a mensagem de erro (código 0x1).' });
    draftId = (await createArticle({ title: 'Rascunho sobre VPN', status: 'draft' })).id;
    archivedId = (await createArticle({ title: 'Procedimento antigo de rede', status: 'archived' })).id;
  });

  it('readers only get published articles: drafts and archived ones are 404 and never listed', async () => {
    const titles = await searchTitles('');
    assert.equal(titles.length, 3);
    assert.equal(titles.some((title: string) => /Rascunho|antigo/.test(title)), false);
    assert.equal((await api('GET', `/articles/${draftId}`, requester)).status, 404);
    assert.equal((await api('GET', `/articles/${archivedId}`, requester)).status, 404);
    assert.equal((await api('GET', '/articles?q=rascunho', requester)).body.articles.length, 0);
    // The team can open a draft to edit it, and lists every status.
    assert.equal((await api('GET', `/articles/${draftId}`, tech)).status, 200);
    assert.equal((await api('GET', '/articles/manage?status=draft', tech)).body.pagination.total, 1);
  });

  it('finds words in title or content, without accents or case, and filters by category', async () => {
    assert.deepEqual(await searchTitles('q=IMPRESSORA'), ['Impressora não imprime']);
    assert.deepEqual(await searchTitles('q=conexao'), ['Conexão instável no escritório'], 'accent-insensitive');
    assert.deepEqual(await searchTitles('q=roteador'), ['Conexão instável no escritório'], 'matches the body');
    assert.deepEqual(await searchTitles('q=reinicie%20computador'), ['Programa fecha sozinho'], 'every word must match');
    assert.deepEqual(await searchTitles('category=hardware'), ['Impressora não imprime']);
    assert.deepEqual(await searchTitles('q=impressora&category=rede'), []);
    assert.deepEqual(await searchTitles(`q=${encodeURIComponent('0x1)')}`), ['Programa fecha sozinho'], 'special characters are literal');
    assert.deepEqual(await searchTitles('q=.*'), [], 'not a regular expression');
    assert.deepEqual(await searchTitles('q=%20%20'), (await searchTitles('')), 'a blank search lists everything');
  });

  it('paginates and limits the page size', async () => {
    const page = await api('GET', '/articles?limit=2&page=2', requester);
    assert.equal(page.body.articles.length, 1);
    assert.deepEqual(page.body.pagination, { page: 2, limit: 2, total: 3, totalPages: 2 });
    assert.equal((await api('GET', '/articles?limit=500', requester)).status, 400);
    assert.equal((await api('GET', `/articles?q=${'a'.repeat(101)}`, requester)).status, 400);
  });

  it('lists only summaries; the body comes with a single article, stored as plain text', async () => {
    const list = await api('GET', '/articles', requester);
    assert.equal('body' in list.body.articles[0], false);
    const scripted = await createArticle({ title: 'Texto com marcação', body: '<script>alert(1)</script> <img src=x onerror=alert(2)> continua texto.' });
    const read = await api('GET', `/articles/${scripted.id}`, requester);
    assert.equal(read.body.article.body, '<script>alert(1)</script> <img src=x onerror=alert(2)> continua texto.', 'kept as typed; the UI renders it as text');
  });
});

describe('"did this help?"', () => {
  it('one answer per person: repeating does not inflate, answering again replaces it', async () => {
    const created = await createArticle({ title: 'Artigo avaliado pelos leitores' });
    for (let i = 0; i < 3; i += 1) assert.equal((await api('PUT', `/articles/${created.id}/feedback`, requester, { helpful: true })).status, 200);
    await Promise.all([1, 2, 3].map(() => api('PUT', `/articles/${created.id}/feedback`, otherRequester, { helpful: true })));
    let totals = (await api('GET', `/articles/${created.id}`, tech)).body.article;
    assert.equal(totals.helpfulCount, 2);
    assert.equal(totals.notHelpfulCount, 0);

    await api('PUT', `/articles/${created.id}/feedback`, otherRequester, { helpful: false });
    totals = (await api('GET', `/articles/${created.id}`, tech)).body.article;
    assert.equal(totals.helpfulCount, 1);
    assert.equal(totals.notHelpfulCount, 1);
    assert.equal(await ArticleFeedbackModel.countDocuments({ article: created.id }), 2);
  });

  it('readers see only their own answer: no totals and no identities', async () => {
    const created = await createArticle({ title: 'Artigo com avaliações privadas' });
    await api('PUT', `/articles/${created.id}/feedback`, otherRequester, { helpful: false });
    const before = await api('GET', `/articles/${created.id}`, requester);
    assert.equal(before.body.article.myFeedback, null);
    await api('PUT', `/articles/${created.id}/feedback`, requester, { helpful: true });
    const mine = await api('GET', `/articles/${created.id}`, requester);
    assert.equal(mine.body.article.myFeedback, true);
    for (const restricted of ['helpfulCount', 'notHelpfulCount', otherRequester.id, otherRequester.email, 'createdBy', 'status']) {
      assert.equal(mine.raw.includes(restricted), false, `reader response must not include ${restricted}`);
    }
  });

  it('validates the answer and refuses feedback on drafts; the user comes from the token', async () => {
    const draft = await createArticle({ title: 'Rascunho sem avaliação', status: 'draft' });
    assert.equal((await api('PUT', `/articles/${draft.id}/feedback`, requester, { helpful: true })).status, 404);
    const published = await createArticle({ title: 'Artigo para validar avaliação' });
    assert.equal((await api('PUT', `/articles/${published.id}/feedback`, requester, { helpful: 'sim' })).status, 400);
    assert.equal((await api('PUT', `/articles/${published.id}/feedback`, requester, { helpful: true, userId: otherRequester.id })).status, 400);
  });
});
