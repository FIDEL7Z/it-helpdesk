import { env } from '../../config/env';
import { HttpError } from '../../errors/http-error';
import type { PublicUser } from '../../models/user.model';
import { GEMINI_DEFAULT_MODEL, geminiProvider } from './gemini.provider';
import { AssistantUnavailable, demoProvider, workerProvider, type AnswerUsage, type AssistantProvider } from './providers';
import { openConversation, remember, type Turn } from './conversation';
import { gatherSources, type AssistantSource, type SourceKind } from './sources';
import { SourceCollector, runTool, toolDeclarationsFor, toolLabel } from './tools';

/*
 * Advisory assistant, in two ways:
 * - conversation (Gemini): the model talks freely and asks for the backend's read-only tools when
 *   it needs data (tools.ts); each call is checked against the person's role and runs with their scope;
 * - retrieval (Cloudflare Worker, demonstration): the backend picks the sources for the question
 *   (sources.ts) and the provider answers from them.
 * Either way the backend checks every citation, never changes tickets or stock, keeps no conversation
 * beyond a short in-memory history (conversation.ts) and never lets the model reach the database.
 * Without a working provider it says so: the reply is an identified demonstration.
 */

export interface AssistantReply {
  answer: string;
  mode: 'ai' | 'demo';
  /** Which generative provider answered (AI mode only). */
  provider: 'gemini' | 'cloudflare' | null;
  /** Why the reply is a demonstration (no provider configured, or the provider failed). */
  notice: string | null;
  /** not_configured, a configuration problem (GEMINI_NOT_CONFIGURED...) or the provider's failure (QUOTA_EXCEEDED, UNAUTHORIZED...). */
  demoReason: string | null;
  model: string | null;
  /** AI mode only: token counts reported by the model. */
  usage: AnswerUsage | null;
  sources: { id: string; kind: SourceKind; title: string; link: string | null }[];
  /** What the assistant looked up in the system for this answer (empty for general advice). */
  toolsUsed: string[];
  /** Send it back with the next question to continue the conversation. */
  conversationId: string;
}

type ReplyBody = Omit<AssistantReply, 'conversationId'>;

type ProviderSettings = Pick<typeof env, 'AI_PROVIDER' | 'GEMINI_API_KEY' | 'GEMINI_MODEL' | 'AI_WORKER_URL' | 'AI_WORKER_KEY'>;
interface ResolvedProvider {
  provider: AssistantProvider;
  /** Set when the chosen provider could not be used and the demonstration answers instead. */
  reason: string | null;
}

const WORKER_KEY = /^[A-Za-z0-9_-]{24,128}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const httpUrl = (value: string | undefined) => {
  try {
    return value ? ['http:', 'https:'].includes(new URL(value).protocol) : false;
  } catch {
    return false;
  }
};

/**
 * The provider comes only from the backend environment (AI_PROVIDER), never from the request.
 * Unset keeps older setups working: the Cloudflare Worker when AI_WORKER_* is set, demo otherwise.
 */
export function resolveProvider(settings: ProviderSettings = env): ResolvedProvider {
  const chosen = settings.AI_PROVIDER ?? (settings.AI_WORKER_URL || settings.AI_WORKER_KEY ? 'cloudflare' : 'demo');
  if (chosen === 'demo') return { provider: demoProvider, reason: null };
  if (chosen === 'gemini') {
    const model = settings.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;
    if (!settings.GEMINI_API_KEY || !MODEL_ID.test(model)) return { provider: demoProvider, reason: 'GEMINI_NOT_CONFIGURED' };
    return { provider: geminiProvider({ apiKey: settings.GEMINI_API_KEY, model }), reason: null };
  }
  if (chosen === 'cloudflare') {
    if (!httpUrl(settings.AI_WORKER_URL) || !WORKER_KEY.test(settings.AI_WORKER_KEY ?? '')) return { provider: demoProvider, reason: 'CLOUDFLARE_NOT_CONFIGURED' };
    return { provider: workerProvider(settings.AI_WORKER_URL!, settings.AI_WORKER_KEY!), reason: null };
  }
  return { provider: demoProvider, reason: 'INVALID_PROVIDER' };
}

/** Says why the demonstration was chosen, the usual surprise being a Gemini key without AI_PROVIDER. */
function providerDetail(name: string): string {
  if (name === 'gemini') return ` (${env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL})`;
  if (name !== 'demo') return '';
  if (env.AI_PROVIDER) return ` (AI_PROVIDER=${env.AI_PROVIDER})`;
  return env.GEMINI_API_KEY
    ? ' (AI_PROVIDER is not set: a GEMINI_API_KEY alone does not turn Gemini on; set AI_PROVIDER=gemini)'
    : ' (AI_PROVIDER is not set)';
}

let override: ResolvedProvider | null = null;
let configured: ResolvedProvider | null = null;

function provider(): ResolvedProvider {
  if (override) return override;
  if (!configured) {
    configured = resolveProvider();
    // Names only: keys and addresses are never logged.
    console.log(configured.reason
      ? `[assistant] AI_PROVIDER is not usable (${configured.reason}); answering in demonstration mode`
      : `[assistant] provider: ${configured.provider.name}${providerDetail(configured.provider.name)}`);
  }
  return configured;
}

/** Logs the chosen provider at startup, so a demonstration by configuration is visible at once. */
export function announceAssistantProvider(): void {
  provider();
}

/** Tests swap the answer provider without touching the environment. */
export function setAssistantProviderForTests(next: AssistantProvider | null, reason: string | null = null): void {
  override = next ? { provider: next, reason } : null;
  inFlight.clear();
  recent.clear();
  running = 0;
}

const DEMO_NOTICE = 'Modo demonstrativo: nenhuma IA generativa está conectada. A resposta lista as informações encontradas para o seu perfil.';
const DEMO_SUFFIX = 'Esta é uma resposta demonstrativa, sem IA, montada com as mesmas informações.';
const MISCONFIGURED = `A IA escolhida para este ambiente não está configurada corretamente. ${DEMO_SUFFIX}`;
/** Why the provider did not answer, in the person's words; always says the reply is a demonstration. */
const FALLBACK_NOTICES: Record<string, string> = {
  AI_DISABLED: `A IA está desligada no momento. ${DEMO_SUFFIX}`,
  QUOTA_EXCEEDED: `A cota diária gratuita da IA acabou; ela volta no dia seguinte. ${DEMO_SUFFIX}`,
  UNAUTHORIZED: `A chave de acesso à IA deste ambiente é inválida ou venceu. ${DEMO_SUFFIX}`,
  RATE_LIMITED: `Muitas perguntas à IA neste minuto. ${DEMO_SUFFIX}`,
  MODEL_BUSY: `A IA gratuita está sobrecarregada agora; tente de novo em instantes. ${DEMO_SUFFIX}`,
  timeout: `A IA demorou demais para responder; tente de novo em instantes. ${DEMO_SUFFIX}`,
  BUSY: `Muitas perguntas à IA ao mesmo tempo. ${DEMO_SUFFIX}`,
  MODEL_REQUIRES_PAID_PLAN: `O modelo configurado não está disponível no plano gratuito. ${DEMO_SUFFIX}`,
  GEMINI_NOT_CONFIGURED: MISCONFIGURED,
  CLOUDFLARE_NOT_CONFIGURED: MISCONFIGURED,
  INVALID_PROVIDER: MISCONFIGURED,
};
const fallbackNotice = (reason: string) => FALLBACK_NOTICES[reason] ?? `A IA está indisponível no momento. ${DEMO_SUFFIX}`;

/*
 * Quota protection for generative providers (on top of the 20 questions per 10 minutes per person
 * in the route): one question at a time per person, the same question not repeated within 30 s,
 * and a few model calls at once for the whole backend. Nothing here calls the model.
 */
export const ASSISTANT_USE_LIMITS = Object.freeze({ maxConcurrent: 3, repeatWindowMs: 30_000, rememberedPeople: 1_000 });
const inFlight = new Set<string>();
const recent = new Map<string, { question: string; at: number }>();
let running = 0;

function claimAiTurn(personId: string, question: string): void {
  if (inFlight.has(personId)) throw new HttpError(429, 'Wait for the answer to your previous question', 'ASSISTANT_BUSY');
  const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
  const last = recent.get(personId);
  const now = Date.now();
  if (last && last.question === normalized && now - last.at < ASSISTANT_USE_LIMITS.repeatWindowMs) {
    throw new HttpError(429, 'You just asked this question', 'ASSISTANT_REPEATED');
  }
  recent.delete(personId);
  recent.set(personId, { question: normalized, at: now });
  if (recent.size > ASSISTANT_USE_LIMITS.rememberedPeople) recent.delete(recent.keys().next().value!);
  inFlight.add(personId);
}

async function withModelSlot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= ASSISTANT_USE_LIMITS.maxConcurrent) throw new AssistantUnavailable('BUSY');
  running += 1;
  try {
    return await run();
  } finally {
    running -= 1;
  }
}

/**
 * Only sources found for this question count; any other [S..] marker is removed from the text.
 * Grouped markers ([S1, S9]) are split and checked one by one. The answer is plain text: tags go.
 */
function checkCitations(text: string, sources: AssistantSource[]): { answer: string; cited: AssistantSource[] } {
  const known = new Map(sources.map((source) => [source.id, source]));
  const answer = text
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi, '')
    .replace(/\[(S\d{1,2}(?:\s*[,;]\s*S\d{1,2})*)\]/g, (_marker, list: string) =>
      list.split(/\s*[,;]\s*/).filter((id) => known.has(id)).map((id) => `[${id}]`).join(''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();
  const cited = [...new Set([...answer.matchAll(/\[(S\d{1,2})\]/g)].map((match) => match[1]))].map((id) => known.get(id)!);
  return { answer, cited };
}

const publicSources = (sources: AssistantSource[]) => sources.map(({ id, kind, title, link }) => ({ id, kind, title, link }));

/**
 * Retrieval: the backend picks the sources for the question; the Worker (or the demonstration)
 * answers from them. `failure` is set when Gemini failed and the demonstration stands in.
 */
async function retrieve(actor: PublicUser, question: string, chosen: AssistantProvider, reason: string | null, failure?: string): Promise<ReplyBody> {
  const sources = await gatherSources(actor, question);
  let output;
  let mode = chosen.mode;
  let notice = failure ? fallbackNotice(failure) : chosen.mode === 'demo' ? (reason ? fallbackNotice(reason) : DEMO_NOTICE) : null;
  let demoReason: string | null = failure ?? (chosen.mode === 'demo' ? reason ?? 'not_configured' : null);
  try {
    const answer = chosen.answer?.bind(chosen);
    if (!answer) throw new AssistantUnavailable('MODEL_UNAVAILABLE');
    const input = { question, profile: actor.role, sources };
    output = chosen.mode === 'ai' ? await withModelSlot(() => answer(input)) : await answer(input);
  } catch (error) {
    if (!(error instanceof AssistantUnavailable)) throw error;
    console.error(`[assistant] ${chosen.name} unavailable (${error.reason}); answering in demonstration mode`);
    output = await demoProvider.answer({ question, profile: actor.role, sources });
    mode = 'demo';
    notice = fallbackNotice(error.reason);
    demoReason = error.reason;
  }
  const { answer, cited } = checkCitations(output.answer, sources);
  const shown = cited.length ? cited : sources.filter((source) => output.citedSources.includes(source.id));
  const answeredByModel = mode === 'ai' && chosen.name !== 'demo';
  return {
    answer,
    mode,
    provider: answeredByModel ? (chosen.name as 'gemini' | 'cloudflare') : null,
    notice,
    demoReason,
    model: answeredByModel ? output.model : null,
    usage: answeredByModel ? output.usage ?? null : null,
    sources: publicSources(shown),
    toolsUsed: [],
  };
}

/** Conversation: the model answers, asking for the read-only tools when it needs data. */
async function converse(actor: PublicUser, question: string, chosen: AssistantProvider, history: Turn[]): Promise<ReplyBody> {
  const talk = chosen.converse?.bind(chosen);
  if (!talk) throw new AssistantUnavailable('MODEL_UNAVAILABLE');
  const collector = new SourceCollector();
  const output = await withModelSlot(() => talk({
    profile: actor.role,
    history,
    message: question,
    tools: toolDeclarationsFor(actor),
    runTool: (name, args) => runTool(actor, name, args, collector),
  }));
  const { answer, cited } = checkCitations(output.answer, collector.sources);
  // Data looked up but not cited still came from the system: show it, so nothing looks invented.
  const shown = cited.length ? cited : collector.sources.slice(0, 3);
  return {
    answer,
    mode: 'ai',
    provider: chosen.name === 'demo' ? null : chosen.name,
    notice: null,
    demoReason: null,
    model: output.model,
    usage: output.usage,
    sources: publicSources(shown),
    toolsUsed: [...collector.used].map(toolLabel).filter((label): label is string => Boolean(label)),
  };
}

export async function ask(actor: PublicUser, question: string, conversationId?: string): Promise<AssistantReply> {
  const { provider: chosen, reason } = provider();
  const usesModel = chosen.mode === 'ai';
  if (usesModel) claimAiTurn(actor.id, question);
  const conversation = openConversation(actor, conversationId);
  try {
    if (!chosen.converse) return { ...(await retrieve(actor, question, chosen, reason)), conversationId: conversation.id };
    try {
      const reply = await converse(actor, question, chosen, conversation.turns);
      remember(actor, conversation.id, question, reply.answer);
      return { ...reply, conversationId: conversation.id };
    } catch (error) {
      if (!(error instanceof AssistantUnavailable)) throw error;
      console.error(`[assistant] ${chosen.name} unavailable (${error.reason}); answering in demonstration mode`);
      return { ...(await retrieve(actor, question, demoProvider, null, error.reason)), conversationId: conversation.id };
    }
  } finally {
    if (usesModel) inFlight.delete(actor.id);
  }
}
