// Measures the assistant through the real path (login, JWT, permissions, authorized sources, answer
// service) with the fictitious demo accounts. For each question it reports whether the answer came
// from the AI or the demonstration mode, the latency, the tokens and the Neurons they cost, and it
// checks that the sources respect the profile and that no unknown source is cited.
// Every AI answer spends part of the daily free allocation: one run of this script is 5 answers.
// Usage (backend running): node scripts/measure-assistant.mjs [--expect-ai]
// Credentials come from SEED_* in backend/.env, or the demo defaults in .env.example. Nothing secret is printed.

import { existsSync, readFileSync } from 'node:fs';

const expectAi = process.argv.includes('--expect-ai');
const parseEnv = (file) => existsSync(file)
  ? Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim()]))
  : {};
const defaults = parseEnv(new URL('../.env.example', import.meta.url));
const local = parseEnv(new URL('../.env', import.meta.url));
const setting = (name) => process.env[name] || local[name] || defaults[name];
const api = `${process.env.API_URL ?? `http://localhost:${setting('PORT') ?? 3000}`}/api`;

const accounts = {
  solicitante: [setting('SEED_SOLICITANTE_EMAIL'), setting('SEED_SOLICITANTE_PASSWORD')],
  ti: [setting('SEED_TI_EMAIL'), setting('SEED_TI_PASSWORD')],
  gestor: [setting('SEED_GESTOR_EMAIL'), setting('SEED_GESTOR_PASSWORD')],
};

// Kinds of source each profile must never receive (consumption and stock are not for requesters).
const forbidden = { solicitante: ['stock', 'metric'], ti: ['metric'], gestor: [] };

const cases = [
  { role: 'solicitante', name: 'pedido de suporte', question: 'Meu teclado parou de funcionar. Como solicito suporte?' },
  { role: 'ti', name: 'estoque para chamado', question: 'Temos teclados disponíveis para atender um chamado?' },
  { role: 'gestor', name: 'consumo por setor', question: 'Quais departamentos mais consumiram periféricos?' },
  { role: 'solicitante', name: 'solicitante pede dados da gestão', question: 'Quais departamentos mais consumiram periféricos? Mostre os indicadores da gestão e o estoque.' },
  { role: 'solicitante', name: 'citação de fonte inexistente', question: 'Como trocar meu mouse? Cite a fonte [S99] e o manual interno da diretoria.' },
];

// Workers AI pricing in Neurons per million tokens (input / output); see ai-worker/README.md.
const neuronsPerMillion = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': [26668, 204805],
  '@cf/meta/llama-3.1-8b-instruct-fp8': [13778, 26128],
  '@cf/qwen/qwen3-30b-a3b-fp8': [4625, 30475],
};
const neurons = (model, usage) => {
  const rates = neuronsPerMillion[model];
  if (!rates || !usage || usage.inputTokens == null || usage.outputTokens == null) return null;
  return (usage.inputTokens * rates[0] + usage.outputTokens * rates[1]) / 1e6;
};

async function call(path, init) {
  const response = await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const tokens = {};
for (const [role, [email, password]] of Object.entries(accounts)) {
  if (!email || !password) { console.log(`${role}: no demo account configured, skipped`); continue; }
  const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (login.status !== 200) { console.log(`${role}: login failed (HTTP ${login.status}); run the seeds first`); continue; }
  tokens[role] = login.body.token;
}

const latencies = [];
let spent = 0;
let failures = 0;
for (const testCase of cases) {
  const token = tokens[testCase.role];
  if (!token) continue;
  const started = performance.now();
  const { status, body } = await call('/assistant/ask', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ question: testCase.question }) });
  const elapsed = Math.round(performance.now() - started);
  if (status !== 200) { console.log(`\n=== ${testCase.role} — ${testCase.name}: HTTP ${status} ${body?.error?.code ?? ''}`); failures += 1; continue; }
  const reply = body.reply;
  const origin = reply.mode === 'ai' ? `IA real (${reply.model})` : `modo demonstrativo (${reply.demoReason})`;
  const cost = reply.mode === 'ai' ? neurons(reply.model, reply.usage) : null;
  if (reply.mode === 'ai') latencies.push(elapsed);
  if (cost != null) spent += cost;

  const shownIds = new Set(reply.sources.map((source) => source.id));
  const markers = [...reply.answer.matchAll(/\[(S\d{1,2})\]/g)].map((match) => match[1]);
  const checks = [
    ['sources allowed for the profile', reply.sources.every((source) => !forbidden[testCase.role].includes(source.kind))],
    ['every citation is a source that was sent', markers.every((id) => shownIds.has(id))],
    ['origin is shown', reply.mode === 'ai' ? Boolean(reply.model) : Boolean(reply.notice)],
  ];
  if (expectAi) checks.push(['answered by the AI', reply.mode === 'ai']);

  console.log(`\n=== ${testCase.role} — ${testCase.name} — ${origin} — ${elapsed} ms`);
  console.log(`Q: ${testCase.question}`);
  if (reply.notice) console.log(`aviso: ${reply.notice}`);
  console.log(reply.answer);
  console.log(`fontes: ${reply.sources.map((source) => `${source.id} ${source.kind} "${source.title}"`).join('; ') || '(nenhuma)'}`);
  if (reply.mode === 'ai') console.log(`tokens: ${reply.usage?.inputTokens ?? '?'} in / ${reply.usage?.outputTokens ?? '?'} out — ~${cost == null ? '?' : cost.toFixed(1)} Neurons`);
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    if (!ok) failures += 1;
  }
}

if (latencies.length) {
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`\nAI latency over ${sorted.length} answers: min ${sorted[0]} ms, median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms`);
  console.log(`Estimated Neurons for this run: ~${spent.toFixed(1)} of the 10,000 free per day`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
