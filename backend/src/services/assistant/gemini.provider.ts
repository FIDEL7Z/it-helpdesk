import { ApiError, GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { z } from 'zod';
import { AssistantUnavailable, type AssistantProvider } from './providers';
import { systemRules, userPrompt } from './prompt';
import { SOURCE_LIMITS } from './sources';

/*
 * Google Gemini API, called directly by the backend. The model receives only the question and the
 * sources this backend already authorized; it has no tools (no search, no code execution, no
 * function calling) and no way to reach the database. The key stays in the backend environment:
 * it is never logged, never returned and never sent to the browser.
 */

export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_LIMITS = Object.freeze({
  timeoutMs: 20_000,
  // Includes the model's thinking tokens; answers are short (a few paragraphs at most).
  maxOutputTokens: 1_024,
  // Question (500) + fenced sources (6,000 + titles and markers): anything larger is a bug upstream.
  maxPromptChars: 8_000,
  maxAnswerChars: 4_000,
});

/** Only the call this provider uses, so tests can pass a fake client and spend no quota. */
export interface GeminiClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> };
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'Resposta em português do Brasil, com os marcadores [S1], [S2]... das fontes usadas.' },
    citedSources: { type: 'array', items: { type: 'string' }, description: 'Identificadores das fontes citadas, por exemplo ["S1"].' },
  },
  required: ['answer', 'citedSources'],
} as const;

// The structured output is validated again here: a schema hint is not a guarantee.
const answerShape = z.object({
  answer: z.string().trim().min(1).max(GEMINI_LIMITS.maxAnswerChars),
  citedSources: z.array(z.string().regex(/^S\d{1,2}$/)).max(SOURCE_LIMITS.count),
});

/** Maps Gemini failures to the reasons the assistant already explains; provider text is never echoed. */
export function classifyGeminiError(error: unknown): string {
  if (error instanceof ApiError) {
    const text = error.message ?? '';
    if (error.status === 429) return /per ?day|PerDay|daily/i.test(text) ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED';
    if (error.status === 401 || error.status === 403 || /API[_ ]KEY[_ ]INVALID|API key not valid|API key expired/i.test(text)) return 'UNAUTHORIZED';
    if (error.status === 404) return 'MODEL_UNAVAILABLE';
    if (error.status === 503) return 'MODEL_BUSY';
    return 'MODEL_UNAVAILABLE';
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'network';
}

interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Tests: a fake client (no SDK) or a fake fetch (the real SDK, no network). */
  client?: GeminiClient;
  fetch?: typeof fetch;
}

export function geminiProvider({ apiKey, model, client, fetch }: GeminiOptions): AssistantProvider {
  // No retries: a failed answer falls back to the demonstration instead of spending more quota.
  const gemini: GeminiClient = client ?? new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: GEMINI_LIMITS.timeoutMs, retryOptions: { attempts: 1 }, ...(fetch && { fetch }) },
  });
  return {
    mode: 'ai',
    name: 'gemini',
    async answer({ question, profile, sources }) {
      const prompt = userPrompt(question, sources);
      if (prompt.length > GEMINI_LIMITS.maxPromptChars) throw new AssistantUnavailable('TOO_LARGE');

      let response: GenerateContentResponse;
      try {
        response = await gemini.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            systemInstruction: systemRules(profile),
            temperature: 0.2,
            maxOutputTokens: GEMINI_LIMITS.maxOutputTokens,
            responseMimeType: 'application/json',
            responseJsonSchema: ANSWER_SCHEMA,
            abortSignal: AbortSignal.timeout(GEMINI_LIMITS.timeoutMs),
          },
        });
      } catch (error) {
        throw new AssistantUnavailable(classifyGeminiError(error));
      }

      if (response.promptFeedback?.blockReason) throw new AssistantUnavailable('BLOCKED');
      let parsed: z.infer<typeof answerShape>;
      try {
        const text = response.text;
        if (!text?.trim()) throw new AssistantUnavailable('EMPTY_ANSWER');
        parsed = answerShape.parse(JSON.parse(text));
      } catch (error) {
        throw error instanceof AssistantUnavailable ? error : new AssistantUnavailable('MALFORMED_RESPONSE');
      }

      const usage = response.usageMetadata;
      const output = usage ? (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) : null;
      return {
        answer: parsed.answer,
        citedSources: parsed.citedSources,
        model: response.modelVersion ?? model,
        usage: usage ? { inputTokens: usage.promptTokenCount ?? null, outputTokens: output } : null,
      };
    },
  };
}
