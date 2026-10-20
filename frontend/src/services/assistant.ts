import { apiRequest } from './api'

export type AssistantSourceKind = 'article' | 'incident' | 'ticket' | 'stock' | 'metric' | 'guide'

export type AssistantReply = {
  answer: string
  /** ai: generative answer (answer service connected). demo: identified demonstration, no AI. */
  mode: 'ai' | 'demo'
  /** Which generative provider answered (AI mode only). */
  provider: 'gemini' | 'cloudflare' | null
  notice: string | null
  /** not_configured, or why the answer service did not answer (AI_DISABLED, QUOTA_EXCEEDED...). */
  demoReason: string | null
  model: string | null
  /** AI mode only: token counts reported by the model (used to estimate consumption). */
  usage: { inputTokens: number | null; outputTokens: number | null } | null
  sources: { id: string; kind: AssistantSourceKind; title: string; link: string | null }[]
}

/** The backend decides what this profile may see; the question only says what is relevant. */
export function askAssistant(question: string, signal?: AbortSignal): Promise<{ reply: AssistantReply }> {
  return apiRequest('/assistant/ask', { method: 'POST', body: { question }, signal })
}
