import type { UserRole } from '../../models/user.model';
import type { Turn } from './conversation';
import type { AssistantSource } from './sources';
import type { ToolDeclaration } from './tools';

export interface AnswerInput {
  question: string;
  profile: UserRole;
  sources: AssistantSource[];
}

export interface AnswerUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AnswerOutput {
  answer: string;
  citedSources: string[];
  model: string | null;
  /** Token counts reported by the model, to estimate the Neurons used. */
  usage?: AnswerUsage | null;
}

export interface ConverseInput {
  profile: UserRole;
  /** Earlier messages of this conversation (kept by the backend, never sent by the client). */
  history: Turn[];
  message: string;
  /** Only the tools this person's role allows. */
  tools: ToolDeclaration[];
  /** Runs a tool for the authenticated person; the backend checks role and arguments again. */
  runTool(name: string, args: unknown): Promise<Record<string, unknown>>;
}

export interface ConverseOutput {
  answer: string;
  model: string | null;
  usage: AnswerUsage | null;
}

export type ProviderName = 'gemini' | 'cloudflare' | 'demo';

export interface AssistantProvider {
  /** ai: generative answer (Gemini or the Cloudflare Worker). demo: no AI, built from the same sources. */
  readonly mode: 'ai' | 'demo';
  readonly name: ProviderName;
  /** Retrieval: answers from the sources the backend picked for the question (Cloudflare Worker, demo). */
  answer?(input: AnswerInput): Promise<AnswerOutput>;
  /** Conversation: talks freely and asks the backend's read-only tools when it needs data (Gemini). */
  converse?(input: ConverseInput): Promise<ConverseOutput>;
}

/** The answer service could not answer (down, timeout, refused key, quota). */
export class AssistantUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`Assistant service unavailable: ${reason}`);
  }
}

const WORKER_TIMEOUT_MS = 30_000;

/**
 * The Cloudflare Worker in ai-worker/: the backend sends only the question, the profile and the
 * sources it already authorized; the Worker has no access to the database or to anything else.
 */
export function workerProvider(baseUrl: string, key: string): AssistantProvider & Required<Pick<AssistantProvider, 'answer'>> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/answer`;
  return {
    mode: 'ai',
    name: 'cloudflare',
    async answer({ question, profile, sources }) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
          body: JSON.stringify({ question, profile, sources: sources.map(({ id, kind, title, text }) => ({ id, kind, title, text })) }),
        });
      } catch (error) {
        throw new AssistantUnavailable(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
      }
      const body = (await response.json().catch(() => null)) as { answer?: unknown; citedSources?: unknown; model?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown } | null; error?: { code?: string } } | null;
      if (!response.ok) throw new AssistantUnavailable(body?.error?.code ?? `http_${response.status}`);
      if (typeof body?.answer !== 'string' || !body.answer.trim()) throw new AssistantUnavailable('empty_answer');
      return {
        answer: body.answer,
        citedSources: Array.isArray(body.citedSources) ? body.citedSources.filter((id): id is string => typeof id === 'string') : [],
        model: typeof body.model === 'string' ? body.model : null,
        usage: body.usage ? { inputTokens: typeof body.usage.inputTokens === 'number' ? body.usage.inputTokens : null, outputTokens: typeof body.usage.outputTokens === 'number' ? body.usage.outputTokens : null } : null,
      };
    },
  };
}

/**
 * No generative AI: lists what the authorized sources say, with the same citations. Used when no
 * answer service is configured, and as the fallback when it fails. Always shown as a demonstration.
 */
export const demoProvider: AssistantProvider & Required<Pick<AssistantProvider, 'answer'>> = {
  mode: 'demo',
  name: 'demo',
  async answer({ sources }) {
    if (sources.length === 0) {
      return {
        answer: 'Não encontrei informações que você possa ver sobre isso. Tente outras palavras ou, se precisar de ajuda, abra um pedido de suporte.',
        citedSources: [],
        model: null,
      };
    }
    const lines = sources.map((source) => {
      const first = source.text.split(/(?<=[.!?])\s+/)[0] ?? source.text;
      return `• ${source.title}: ${first} [${source.id}]`;
    });
    return {
      answer: ['Encontrei estas informações para você:', ...lines].join('\n'),
      citedSources: sources.map((source) => source.id),
      model: null,
    };
  },
};
