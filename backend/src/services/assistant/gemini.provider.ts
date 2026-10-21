import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentParameters, type GenerateContentResponse, type Part } from '@google/genai';
import { AssistantUnavailable, type AssistantProvider, type ConverseInput, type ConverseOutput } from './providers';
import { conversationRules } from './prompt';

/*
 * Google Gemini API, called directly by the backend, as a conversational assistant. The model talks
 * freely and, when it needs data from this Helpdesk, asks for one of the read-only tools the backend
 * declared for this person's role; the backend checks and runs it (tools.ts) and hands back only the
 * result. No other tool is enabled: no Google Search, no code execution. The key stays in the
 * backend environment: it is never logged, never returned and never sent to the browser.
 */

// Stable, free tier and function calling. Under load on 2026-10-20 it answered in about 2 s while
// gemini-3.5-flash-lite took 20 to 40 s; GEMINI_MODEL can still pick the Flash-Lite.
export const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';
export const GEMINI_LIMITS = Object.freeze({
  /**
   * Each model call; the whole question (tool rounds included) has totalMs. The free tier answers in
   * 1 to 3 s when idle but took 20 to 40 s per call under load (measured on 2026-10-20).
   */
  timeoutMs: 50_000,
  totalMs: 100_000,
  // Includes the model's thinking tokens; analyses of several tools need room for both.
  maxOutputTokens: 4_096,
  /** Rounds in which the model may ask for tools before it must answer (so at most 4 model calls). */
  maxToolRounds: 3,
  // A composite question (productivity + comparison + attention) asks for 3 analyses at once.
  maxCallsPerRound: 4,
  maxAnswerChars: 4_000,
  /** Wait before the single retry of an overloaded call (500, 502, 503, 504). */
  overloadRetryDelayMs: 1_500,
  temperature: 0.3,
});

/** Only the call this provider uses, so tests can pass a fake client and spend no quota. */
export interface GeminiClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> };
}

/** Maps Gemini failures to the reasons the assistant already explains; provider text is never echoed. */
export function classifyGeminiError(error: unknown): string {
  if (error instanceof ApiError) {
    const text = error.message ?? '';
    if (error.status === 429) return /per ?day|PerDay|daily/i.test(text) ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED';
    if (error.status === 401 || error.status === 403 || /API[_ ]KEY[_ ]INVALID|API key not valid|API key expired/i.test(text)) return 'UNAUTHORIZED';
    if (error.status === 404) return 'MODEL_UNAVAILABLE';
    // Overloaded or timed out on Google's side (the free tier under load answers 500, 503 or 504).
    if ([500, 502, 503, 504].includes(error.status)) return 'MODEL_BUSY';
    return 'MODEL_UNAVAILABLE';
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'network';
}

/** The answer text, without the model's thoughts. */
function answerText(response: GenerateContentResponse): string {
  const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('').trim();
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

  async function converse({ profile, history, message, tools, runTool }: ConverseInput): Promise<ConverseOutput> {
    const contents: Content[] = [
      ...history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      { role: 'user', parts: [{ text: message }] },
    ];
    const deadline = Date.now() + GEMINI_LIMITS.totalMs;
    let inputTokens = 0;
    let outputTokens = 0;
    let reported = false;
    let version: string | null = null;

    for (let round = 0; ; round += 1) {
      if (deadline - Date.now() <= 0) throw new AssistantUnavailable('timeout');
      const generate = () => gemini.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: conversationRules(profile),
          temperature: GEMINI_LIMITS.temperature,
          maxOutputTokens: GEMINI_LIMITS.maxOutputTokens,
          ...(tools.length && { tools: [{ functionDeclarations: tools }] }),
          // Gemini 3 models think at a medium level by default: low is faster and leaves room to answer.
          ...(model.startsWith('gemini-3') && { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
          abortSignal: AbortSignal.timeout(Math.min(GEMINI_LIMITS.timeoutMs, Math.max(1, deadline - Date.now()))),
        },
      });
      let response: GenerateContentResponse;
      try {
        response = await generate();
      } catch (error) {
        // The HTTP status only: never the message, which may echo request details.
        if (error instanceof ApiError) console.error(`[assistant] gemini answered HTTP ${error.status}`);
        // One more try only for a momentary overload (no answer was produced), if time allows.
        // Quota and rate limits (429) are never retried, and the model is never switched.
        if (classifyGeminiError(error) !== 'MODEL_BUSY' || deadline - Date.now() < GEMINI_LIMITS.overloadRetryDelayMs + 5_000) {
          throw new AssistantUnavailable(classifyGeminiError(error));
        }
        await new Promise((resolve) => setTimeout(resolve, GEMINI_LIMITS.overloadRetryDelayMs));
        try {
          response = await generate();
        } catch (retryError) {
          if (retryError instanceof ApiError) console.error(`[assistant] gemini answered HTTP ${retryError.status} again`);
          throw new AssistantUnavailable(classifyGeminiError(retryError));
        }
      }

      const usage = response.usageMetadata;
      if (usage) {
        reported = true;
        inputTokens += usage.promptTokenCount ?? 0;
        outputTokens += (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
      }
      version = response.modelVersion ?? version;
      if (response.promptFeedback?.blockReason) throw new AssistantUnavailable('BLOCKED');

      const calls = response.functionCalls ?? [];
      if (calls.length) {
        if (round >= GEMINI_LIMITS.maxToolRounds) throw new AssistantUnavailable('TOOL_LIMIT');
        const content = response.candidates?.[0]?.content;
        if (!content) throw new AssistantUnavailable('MALFORMED_RESPONSE');
        // The model's turn goes back as it came: Gemini needs its thought signatures with the calls.
        contents.push(content);
        const results: Part[] = [];
        for (const [index, call] of calls.entries()) {
          const response = index < GEMINI_LIMITS.maxCallsPerRound
            ? await runTool(call.name ?? '', call.args ?? {})
            : { erro: 'Limite de consultas por pergunta atingido.' };
          results.push({ functionResponse: { ...(call.id && { id: call.id }), name: call.name, response } });
        }
        contents.push({ role: 'user', parts: results });
        continue;
      }

      const text = answerText(response);
      if (!text) throw new AssistantUnavailable('EMPTY_ANSWER');
      // Never let a cut answer pass for a complete one.
      const cut = response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS;
      const answer = cut ? `${text}…

(Resposta interrompida pelo limite de tamanho. Peça um resumo ou uma parte de cada vez.)` : text;
      return {
        answer: answer.slice(0, GEMINI_LIMITS.maxAnswerChars),
        model: version ?? model,
        usage: reported ? { inputTokens, outputTokens } : null,
      };
    }
  }

  return { mode: 'ai', name: 'gemini', converse };
}
