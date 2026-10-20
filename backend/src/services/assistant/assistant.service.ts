import { env } from '../../config/env';
import { HttpError } from '../../errors/http-error';
import type { PublicUser } from '../../models/user.model';
import { GEMINI_DEFAULT_MODEL, geminiProvider } from './gemini.provider';
import { AssistantUnavailable, demoProvider, workerProvider, type AnswerUsage, type AssistantProvider } from './providers';
import { gatherSources, type SourceKind } from './sources';

/*
 * Advisory assistant. The backend authenticates the person, decides which data they may see
 * (sources.ts), sends only that to the answer provider and checks the citations that come back.
 * It never changes tickets or stock, never stores conversations and never lets the model reach
 * the database. Without a working provider it says so: the reply is an identified demonstration.
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
}

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

export async function ask(actor: PublicUser, question: string): Promise<AssistantReply> {
  const { provider: chosen, reason } = provider();
  const usesModel = chosen.mode === 'ai';
  if (usesModel) claimAiTurn(actor.id, question);

  try {
    const sources = await gatherSources(actor, question);
    let output;
    let mode = chosen.mode;
    let notice = chosen.mode === 'demo' ? (reason ? fallbackNotice(reason) : DEMO_NOTICE) : null;
    let demoReason: string | null = chosen.mode === 'demo' ? reason ?? 'not_configured' : null;
    try {
      if (usesModel && running >= ASSISTANT_USE_LIMITS.maxConcurrent) throw new AssistantUnavailable('BUSY');
      if (usesModel) running += 1;
      try {
        output = await chosen.answer({ question, profile: actor.role, sources });
      } finally {
        if (usesModel) running -= 1;
      }
    } catch (error) {
      if (!(error instanceof AssistantUnavailable)) throw error;
      console.error(`[assistant] ${chosen.name} unavailable (${error.reason}); answering in demonstration mode`);
      output = await demoProvider.answer({ question, profile: actor.role, sources });
      mode = 'demo';
      notice = fallbackNotice(error.reason);
      demoReason = error.reason;
    }

    // Only sources this backend sent count; any other [S..] marker is removed from the text. Grouped
    // markers ([S1, S9]) are split and checked one by one. The answer is plain text: tags are dropped.
    const known = new Map(sources.map((source) => [source.id, source]));
    const answer = output.answer
      .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi, '')
      .replace(/\[(S\d{1,2}(?:\s*[,;]\s*S\d{1,2})*)\]/g, (_marker, list: string) =>
        list.split(/\s*[,;]\s*/).filter((id) => known.has(id)).map((id) => `[${id}]`).join(''))
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .trim();
    const cited = [...new Set([...answer.matchAll(/\[(S\d{1,2})\]/g)].map((match) => match[1]))];
    const shown = (cited.length ? cited : output.citedSources.filter((id) => known.has(id))).map((id) => known.get(id)!);
    const answeredByModel = mode === 'ai' && chosen.name !== 'demo';
    return {
      answer,
      mode,
      provider: answeredByModel ? (chosen.name as 'gemini' | 'cloudflare') : null,
      notice,
      demoReason,
      model: answeredByModel ? output.model : null,
      usage: answeredByModel ? output.usage ?? null : null,
      sources: shown.map(({ id, kind, title, link }) => ({ id, kind, title, link })),
    };
  } finally {
    if (usesModel) inFlight.delete(actor.id);
  }
}
