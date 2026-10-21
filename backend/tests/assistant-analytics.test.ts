import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Content, GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { setAssistantProviderForTests } from '../src/services/assistant/assistant.service';
import { CONVERSATION_LIMITS, forgetConversationsForTests, setConversationClockForTests } from '../src/services/assistant/conversation';
import { geminiProvider, type GeminiClient } from '../src/services/assistant/gemini.provider';
import { resolveDates, resolveNamedPeriod, variation } from '../src/services/assistant/periods';
import { createFictitiousData, type FictitiousTokens } from '../scripts/fictitious-data';

// Analyses the assistant can ask for, on the sandbox's fictitious company (the same data as
// npm run dev:ai-sandbox) and a scripted Gemini: no network, no quota. The numbers asserted here
// are the ones the fixture plans: last 7 days Caio 5 and Rita 2 resolutions, the 7 before 3 and 3.
const TEST_DB_NAME = 'it-helpdesk-test-assistant-analytics';
const MODEL = 'gemini-3.6-flash';

type Json = { [key: string]: any };
let server: Server;
let baseUrl: string;
let tokens: FictitiousTokens;

const ask = async (token: string, question: string, conversationId?: string) => {
  const response = await fetch(`${baseUrl}/api/assistant/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question, ...(conversationId && { conversationId }) }),
  });
  return { status: response.status, body: (await response.json()) as Json };
};

const textReply = (text: string): Json => ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80 }, modelVersion: MODEL });
const callsReply = (...calls: [string, Json][]): Json => ({
  candidates: [{ content: { role: 'model', parts: calls.map(([name, args], index) => ({ functionCall: { id: `call-${index}`, name, args }, ...(index === 0 && { thoughtSignature: 'sig' }) })) } }],
  usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 20 },
  modelVersion: MODEL,
});
const resultsOf = (params: GenerateContentParameters): Json[] => ((params.contents as Content[]).at(-1)?.parts ?? [])
  .filter((part: Part) => part.functionResponse).map((part: Part) => part.functionResponse!.response as Json);

type Script = (params: GenerateContentParameters, call: number) => Json;
class FakeGemini implements GeminiClient {
  calls: GenerateContentParameters[] = [];
  constructor(private script: Script) {}
  models = {
    generateContent: async (params: GenerateContentParameters) => {
      this.calls.push({ ...params, contents: [...(params.contents as Content[])] });
      const reply = this.script(params, this.calls.length);
      const parts: Part[] = reply.candidates?.[0]?.content?.parts ?? [];
      const functionCalls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
      return { ...reply, functionCalls: functionCalls.length ? functionCalls : undefined } as unknown as GenerateContentResponse;
    },
  };
  results(): Json[] {
    return this.calls.flatMap((params) => resultsOf(params));
  }
}
/** Asks for the given tools in one round, then answers citing each analysis it received. */
const analyzing = (...calls: [string, Json][]): Script => (params, call) => {
  if (call === 1) return callsReply(...calls);
  const cited = resultsOf(params).map((result) => (result.fonte ? `[${result.fonte}]` : '')).join('');
  return textReply(`Análise feita com os dados consultados ${cited}.`);
};
const use = (gemini: FakeGemini) => setAssistantProviderForTests(geminiProvider({ apiKey: 'test-key-analytics-0123456789', model: MODEL, client: gemini }));

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokens = await createFictitiousData(`${baseUrl}/api`);
});

afterEach(() => {
  setAssistantProviderForTests(null);
  forgetConversationsForTests();
});

after(async () => {
  setAssistantProviderForTests(null);
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('periods, in the application time zone', () => {
  const noon = new Date('2026-10-20T15:00:00Z'); // 12:00 in America/Fortaleza (UTC-3)
  it('resolves named periods into explicit windows with readable labels', () => {
    const tz = 'America/Fortaleza';
    const today = resolveNamedPeriod('hoje', noon, tz);
    assert.deepEqual([today.start.toISOString(), today.end.toISOString(), today.label], ['2026-10-20T03:00:00.000Z', noon.toISOString(), '20/10/2026 (até agora)']);
    const yesterday = resolveNamedPeriod('ontem', noon, tz);
    assert.deepEqual([yesterday.start.toISOString(), yesterday.end.toISOString(), yesterday.label], ['2026-10-19T03:00:00.000Z', '2026-10-20T03:00:00.000Z', '19/10/2026']);
    assert.equal(resolveNamedPeriod('ultimos_7_dias', noon, tz).label, '14/10/2026 a 20/10/2026 (até agora)');
    const lastWeek = resolveNamedPeriod('7_dias_anteriores', noon, tz);
    assert.deepEqual([lastWeek.start.toISOString(), lastWeek.end.toISOString(), lastWeek.label], ['2026-10-07T03:00:00.000Z', '2026-10-14T03:00:00.000Z', '07/10/2026 a 13/10/2026']);
    const lastMonth = resolveNamedPeriod('mes_passado', noon, tz);
    assert.deepEqual([lastMonth.start.toISOString(), lastMonth.end.toISOString()], ['2026-09-01T03:00:00.000Z', '2026-10-01T03:00:00.000Z']);
  });

  it('keeps calendar days across a daylight saving change', () => {
    // New York leaves daylight saving time on 2026-11-01: that day has 25 hours.
    const yesterday = resolveNamedPeriod('ontem', new Date('2026-11-02T17:00:00Z'), 'America/New_York');
    assert.deepEqual([yesterday.start.toISOString(), yesterday.end.toISOString()], ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
  });

  it('accepts two valid dates at most a year apart, never in the future', () => {
    const tz = 'America/Fortaleza';
    const range = resolveDates('2026-10-01', '2026-10-05', noon, tz);
    assert.ok(!('error' in range));
    assert.deepEqual([range.start.toISOString(), range.end.toISOString(), range.label], ['2026-10-01T03:00:00.000Z', '2026-10-06T03:00:00.000Z', '01/10/2026 a 05/10/2026']);
    const open = resolveDates('2026-10-18', '2026-10-25', noon, tz);
    assert.ok(!('error' in open) && open.end.getTime() === noon.getTime(), 'a period reaching today ends now');
    for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-10-05', '2026-10-01'], ['2026-12-01', '2026-12-02'], ['2025-01-01', '2026-10-01']]) {
      assert.ok('error' in resolveDates(from, to, noon, tz), `${from} ${to}`);
    }
  });

  it('computes variations in the backend, without a percent when the base is zero', () => {
    assert.deepEqual(variation(0, 5), { anterior: 0, atual: 5, diferenca: 5, percentual: null });
    assert.deepEqual(variation(4, 5), { anterior: 4, atual: 5, diferenca: 1, percentual: 25 });
    assert.deepEqual(variation(6, 7), { anterior: 6, atual: 7, diferenca: 1, percentual: 16.7 });
    assert.deepEqual(variation(5, 0), { anterior: 5, atual: 0, diferenca: -5, percentual: -100 });
    assert.deepEqual(variation(0, 0).percentual, null);
  });
});

describe('manager analyses', () => {
  it('productivity this week: totals, each person, the queue now and quality', async () => {
    const gemini = new FakeGemini(analyzing(['produtividade_equipe', { periodo: 'ultimos_7_dias' }]));
    use(gemini);
    const reply = (await ask(tokens.lara, 'Como está a produtividade da equipe de TI nesta semana?')).body.reply;
    const [result] = gemini.results();
    assert.match(result.titulo, /^Produtividade da equipe \(\d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4} \(até agora\)\)$/);
    const data = result.dados;
    assert.deepEqual(data.no_periodo, { chamados_abertos: 12, resolucoes: 7, chamados_resolvidos: 7, reaberturas: 0 });
    const people = Object.fromEntries(data.por_pessoa.map((row: Json) => [row.nome, [row.resolucoes_no_periodo, row.pendentes_agora]]));
    assert.deepEqual(people, { 'Caio Mendes': [5, 1], 'Rita Alves': [2, 2] });
    assert.deepEqual(data.fila_agora, { pendentes: 6, em_andamento: 3, sem_responsavel: 3 });
    assert.equal(data.qualidade_das_resolucoes_do_periodo.confirmadas_pelo_solicitante, 1);
    assert.ok(data.como_ler.some((note: string) => /não mede sozinha a qualidade/.test(note)));
    assert.deepEqual(reply.toolsUsed, ['Produtividade da equipe']);
    assert.deepEqual(reply.sources.map((source: Json) => [source.kind, source.link]), [['metric', '/manager']]);
  });

  it('compares this week with the week before, with differences and percents from the backend', async () => {
    const gemini = new FakeGemini(analyzing(['comparar_periodos', {}]));
    use(gemini);
    await ask(tokens.lara, 'Compara esta semana com a semana passada.');
    const data = gemini.results()[0].dados;
    assert.deepEqual(data.resolucoes, { anterior: 6, atual: 7, diferenca: 1, percentual: 16.7 });
    assert.deepEqual(data.resolucoes_por_pessoa, [
      { nome: 'Caio Mendes', anterior: 3, atual: 5, diferenca: 2, percentual: 66.7 },
      { nome: 'Rita Alves', anterior: 3, atual: 2, diferenca: -1, percentual: -33.3 },
    ]);
    assert.deepEqual(data.unidades_de_material_entregues, { anterior: 7, atual: 11, diferenca: 4, percentual: 57.1 });
    assert.equal(data.reaberturas.percentual, null, 'no percent over a zero base');
    assert.deepEqual(data.duracao_em_dias.anterior, 7);
  });

  it('consumption by department, with the products of each one', async () => {
    const gemini = new FakeGemini(analyzing(['consumo_por_departamento', { periodo: 'ultimos_7_dias' }]));
    use(gemini);
    await ask(tokens.lara, 'Quais departamentos estão consumindo mais equipamentos?');
    const data = gemini.results()[0].dados;
    assert.equal(data.unidades_entregues, 11);
    assert.deepEqual(data.por_departamento[0], { departamento: 'Financeiro', unidades: 5, produtos: [{ produto: 'Teclado Logitech K120', unidades: 3 }, { produto: 'Mouse óptico USB', unidades: 2 }] });
    assert.deepEqual(data.por_departamento.map((row: Json) => row.departamento), ['Financeiro', 'Comercial', 'Logística', 'RH']);
    assert.deepEqual(data.estoque_abaixo_do_minimo.map((row: Json) => row.produto), ['Headset USB', 'Cabo HDMI']);
  });

  it('attention points: unassigned urgency, old and idle work, recurring subjects, stock', async () => {
    const gemini = new FakeGemini(analyzing(['pontos_de_atencao', {}]));
    use(gemini);
    await ask(tokens.lara, 'Quais problemas merecem atenção da gestão?');
    const data = gemini.results()[0].dados;
    assert.deepEqual(data.alertas_agora, {
      alta_prioridade_sem_responsavel: 1, pendentes_ha_7_dias_ou_mais: 1, sem_movimentacao_da_equipe_ha_3_dias_ou_mais: 2, pendentes_sem_responsavel: 3, pendentes_no_total: 6,
    });
    assert.equal(data.pendentes_mais_antigos[0].titulo, 'Wi-Fi instável no 2º andar');
    assert.equal(data.pendentes_mais_antigos[0].dias_desde_a_abertura, 10);
    assert.deepEqual(data.abertos_por_categoria_ultimos_30_dias[0], { categoria: 'Computador ou equipamento', quantidade: 8 });
    assert.equal(data.estoque_abaixo_do_minimo.length, 2);
  });

  it('one composite question runs every analysis it needs at once and cites them', async () => {
    const gemini = new FakeGemini(analyzing(['produtividade_equipe', {}], ['comparar_periodos', {}], ['pontos_de_atencao', {}]));
    use(gemini);
    const reply = (await ask(tokens.lara, 'Analise a produtividade da minha equipe, compare com a semana passada e diga o que merece atenção.')).body.reply;
    assert.equal(gemini.calls.length, 2, 'one round of three tools, then the answer');
    assert.deepEqual(reply.toolsUsed, ['Produtividade da equipe', 'Comparação de períodos', 'Pontos de atenção']);
    assert.deepEqual(reply.sources.map((source: Json) => source.id), ['S1', 'S2', 'S3']);
    assert.match(String(gemini.calls[0].config?.systemInstruction), /Os números e percentuais já vêm calculados/);
  });

  it('a follow-up period ("e ontem?") is a new, validated query', async () => {
    const gemini = new FakeGemini((params, call) => (call === 1 ? callsReply(['produtividade_equipe', { periodo: 'hoje' }])
      : call === 2 ? textReply('Hoje a equipe resolveu os chamados mostrados [S1].')
        : call === 3 ? callsReply(['produtividade_equipe', { periodo: 'ontem' }]) : textReply('Ontem, os números foram estes [S1].')));
    use(gemini);
    const first = (await ask(tokens.lara, 'Quantos chamados a equipe resolveu hoje?')).body.reply;
    await ask(tokens.lara, 'E ontem?', first.conversationId);
    const history = gemini.calls[2].contents as Content[];
    assert.match(JSON.stringify(history[0]), /resolveu hoje/);
    const [today, yesterday] = gemini.results();
    assert.match(today.titulo, /\(até agora\)/);
    assert.doesNotMatch(yesterday.titulo, /até agora/);
  });

  it('says there is no data instead of inventing it', async () => {
    const gemini = new FakeGemini(analyzing(['consumo_por_departamento', { de: '2026-01-01', ate: '2026-01-31' }]));
    use(gemini);
    await ask(tokens.lara, 'Quanto material foi entregue em janeiro?');
    const data = gemini.results()[0].dados;
    assert.equal(data.unidades_entregues, 0);
    assert.deepEqual(data.por_departamento, []);
    assert.match(data.aviso, /Nenhuma entrega registrada/);
  });
});

describe('IT analyses and role limits', () => {
  it('IT reads critical stock and recurring subjects, never management analyses', async () => {
    const gemini = new FakeGemini(analyzing(['estoque_critico', {}], ['categorias_recorrentes', { periodo: 'ultimos_7_dias' }], ['produtividade_equipe', {}], ['pontos_de_atencao', {}]));
    use(gemini);
    await ask(tokens.caio, 'O que está acabando no estoque e quais problemas se repetem?');
    const [critical, recurring, productivity, attention] = gemini.results();
    assert.deepEqual(critical.dados.abaixo_do_minimo.map((row: Json) => row.produto), ['Headset USB', 'Cabo HDMI']);
    assert.deepEqual(recurring.dados.por_categoria[0], { categoria: 'Computador ou equipamento', abertos_no_periodo: 5, ainda_pendentes: 2 });
    assert.ok(productivity.erro && attention.erro, 'management analyses are refused for IT');
  });

  it('a requester gets none of the analyses, whatever the model asks', async () => {
    const gemini = new FakeGemini(analyzing(['produtividade_equipe', {}], ['comparar_periodos', {}], ['consumo_por_departamento', {}], ['estoque_critico', {}]));
    use(gemini);
    const reply = (await ask(tokens.bia, 'Mostre a produtividade da equipe e o consumo por departamento.')).body.reply;
    assert.ok(gemini.results().every((result) => result.erro));
    assert.deepEqual(reply.sources, []);
  });

  it('refuses invalid or free-form arguments (no operators, pipelines or open filters)', async () => {
    const gemini = new FakeGemini(analyzing(
      ['produtividade_equipe', { periodo: 'semana' }],
      ['comparar_periodos', { atual: { $gte: '2026-01-01' } }],
      ['consumo_por_departamento', { de: '2026-01-01' }],
      ['produtividade_equipe', { periodo: 'ultimos_7_dias', pipeline: [{ $match: {} }] }],
    ));
    use(gemini);
    await ask(tokens.lara, 'Me dê os números com estes filtros.');
    assert.deepEqual(gemini.results().map((result) => result.erro), [
      'Argumentos inválidos para esta consulta.', 'Argumentos inválidos para esta consulta.', 'Informe as duas datas, "de" e "ate".', 'Argumentos inválidos para esta consulta.',
    ]);
    const tooLong = new FakeGemini(analyzing(['produtividade_equipe', { de: '2024-01-01', ate: '2026-01-01' }]));
    use(tooLong);
    await ask(tokens.lara, 'E nos últimos dois anos?');
    assert.match(tooLong.results()[0].erro, /no máximo 366 dias/);
  });

  it('drops citations that no tool returned, and shows the analyses actually used', async () => {
    const gemini = new FakeGemini((_params, call) => (call === 1 ? callsReply(['produtividade_equipe', {}]) : textReply('A equipe resolveu 7 chamados, segundo o relatório interno [S4].')));
    use(gemini);
    const reply = (await ask(tokens.lara, 'Resumo da semana, por favor.')).body.reply;
    assert.equal(reply.answer, 'A equipe resolveu 7 chamados, segundo o relatório interno.');
    assert.deepEqual(reply.sources.map((source: Json) => source.title.split(' (')[0]), ['Produtividade da equipe']);
  });
});

describe('conversation memory', () => {
  it('expires after the idle time and never crosses people or profiles', async () => {
    let now = Date.now();
    setConversationClockForTests(() => now);
    const gemini = new FakeGemini(() => textReply('Certo.'));
    use(gemini);
    const first = (await ask(tokens.lara, 'Vamos falar da equipe.')).body.reply;
    now += CONVERSATION_LIMITS.idleMs + 1;
    const later = (await ask(tokens.lara, 'E agora?', first.conversationId)).body.reply;
    assert.notEqual(later.conversationId, first.conversationId);
    assert.equal((gemini.calls[1].contents as Content[]).length, 1, 'the expired history is gone');
    const other = (await ask(tokens.caio, 'E agora?', later.conversationId)).body.reply;
    assert.notEqual(other.conversationId, later.conversationId);
    assert.equal((gemini.calls[2].contents as Content[]).length, 1);
  });
});
