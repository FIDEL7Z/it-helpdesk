import { env } from '../../config/env';
import type { PublicUser } from '../../models/user.model';
import { AssistantUnavailable, demoProvider, workerProvider, type AnswerUsage, type AssistantProvider } from './providers';
import { gatherSources, type SourceKind } from './sources';

/*
 * Advisory assistant. The backend authenticates the person, decides which data they may see
 * (sources.ts), sends only that to the answer service and checks the citations that come back.
 * It never changes tickets or stock, never stores conversations and never lets the model reach
 * the database. Without an answer service it says so: the reply is an identified demonstration.
 */

export interface AssistantReply {
  answer: string;
  mode: 'ai' | 'demo';
  /** Why the reply is a demonstration (no service configured, or the service failed). */
  notice: string | null;
  /** not_configured, or the answer service's error code (AI_DISABLED, QUOTA_EXCEEDED, UNAUTHORIZED...). */
  demoReason: string | null;
  model: string | null;
  /** AI mode only: token counts reported by the model. */
  usage: AnswerUsage | null;
  sources: { id: string; kind: SourceKind; title: string; link: string | null }[];
}

let override: AssistantProvider | null = null;
let configured: AssistantProvider | null = null;

function provider(): AssistantProvider {
  if (override) return override;
  configured ??= env.AI_WORKER_URL && env.AI_WORKER_KEY ? workerProvider(env.AI_WORKER_URL, env.AI_WORKER_KEY) : demoProvider;
  return configured;
}

/** Tests swap the answer service without touching the environment. */
export function setAssistantProviderForTests(next: AssistantProvider | null): void {
  override = next;
}

const DEMO_NOTICE = 'Modo demonstrativo: nenhuma IA generativa está conectada. A resposta lista as informações encontradas para o seu perfil.';
const DEMO_SUFFIX = 'Esta é uma resposta demonstrativa, sem IA, montada com as mesmas informações.';
/** Why the answer service did not answer, in the person's words; always says the reply is a demonstration. */
const FALLBACK_NOTICES: Record<string, string> = {
  AI_DISABLED: `A IA está desligada no momento. ${DEMO_SUFFIX}`,
  QUOTA_EXCEEDED: `A cota diária gratuita da IA acabou; ela volta à 00:00 UTC (21h em Brasília). ${DEMO_SUFFIX}`,
  UNAUTHORIZED: `A chave de acesso à IA deste ambiente é inválida ou venceu. ${DEMO_SUFFIX}`,
  RATE_LIMITED: `Muitas perguntas à IA neste minuto. ${DEMO_SUFFIX}`,
  MODEL_REQUIRES_PAID_PLAN: `O modelo configurado não está disponível no plano gratuito. ${DEMO_SUFFIX}`,
};
const fallbackNotice = (reason: string) => FALLBACK_NOTICES[reason] ?? `A IA está indisponível no momento. ${DEMO_SUFFIX}`;

export async function ask(actor: PublicUser, question: string): Promise<AssistantReply> {
  const sources = await gatherSources(actor, question);
  const chosen = provider();
  let output;
  let mode = chosen.mode;
  let notice = chosen.mode === 'demo' ? DEMO_NOTICE : null;
  let demoReason: string | null = chosen.mode === 'demo' ? 'not_configured' : null;
  try {
    output = await chosen.answer({ question, profile: actor.role, sources });
  } catch (error) {
    if (!(error instanceof AssistantUnavailable)) throw error;
    console.error(`[assistant] answer service unavailable (${error.reason}); answering in demonstration mode`);
    output = await demoProvider.answer({ question, profile: actor.role, sources });
    mode = 'demo';
    notice = fallbackNotice(error.reason);
    demoReason = error.reason;
  }

  // Only sources this backend sent count; any other [S..] marker is removed from the text.
  const known = new Map(sources.map((source) => [source.id, source]));
  const answer = output.answer
    .replace(/\[(S\d{1,2})\]/g, (marker, id: string) => (known.has(id) ? marker : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();
  const cited = [...new Set([...answer.matchAll(/\[(S\d{1,2})\]/g)].map((match) => match[1]))];
  const shown = (cited.length ? cited : output.citedSources.filter((id) => known.has(id))).map((id) => known.get(id)!);
  return {
    answer,
    mode,
    notice,
    demoReason,
    model: mode === 'ai' ? output.model : null,
    usage: mode === 'ai' ? output.usage ?? null : null,
    sources: shown.map(({ id, kind, title, link }) => ({ id, kind, title, link })),
  };
}
