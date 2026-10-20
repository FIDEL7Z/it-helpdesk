import { env } from '../../config/env';
import type { PublicUser } from '../../models/user.model';
import { AssistantUnavailable, demoProvider, workerProvider, type AssistantProvider } from './providers';
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
  model: string | null;
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
const FALLBACK_NOTICE = 'A IA está indisponível no momento. Esta é uma resposta demonstrativa, montada com as mesmas informações.';

export async function ask(actor: PublicUser, question: string): Promise<AssistantReply> {
  const sources = await gatherSources(actor, question);
  const chosen = provider();
  let output;
  let mode = chosen.mode;
  let notice = chosen.mode === 'demo' ? DEMO_NOTICE : null;
  try {
    output = await chosen.answer({ question, profile: actor.role, sources });
  } catch (error) {
    if (!(error instanceof AssistantUnavailable)) throw error;
    console.error(`[assistant] answer service unavailable (${error.reason}); answering in demonstration mode`);
    output = await demoProvider.answer({ question, profile: actor.role, sources });
    mode = 'demo';
    notice = FALLBACK_NOTICE;
  }

  // Only sources this backend sent count; any other [S..] marker is removed from the text.
  const known = new Map(sources.map((source) => [source.id, source]));
  const answer = output.answer.replace(/\[(S\d{1,2})\]/g, (marker, id: string) => (known.has(id) ? marker : '')).replace(/[ \t]{2,}/g, ' ').trim();
  const cited = [...new Set([...answer.matchAll(/\[(S\d{1,2})\]/g)].map((match) => match[1]))];
  const shown = (cited.length ? cited : output.citedSources.filter((id) => known.has(id))).map((id) => known.get(id)!);
  return {
    answer,
    mode,
    notice,
    model: mode === 'ai' ? output.model : null,
    sources: shown.map(({ id, kind, title, link }) => ({ id, kind, title, link })),
  };
}
