import { apiRequest } from './api'

export type AssistantSourceKind = 'article' | 'incident' | 'ticket' | 'stock' | 'metric'

export type AssistantReply = {
  answer: string
  /** ai: generative answer (answer service connected). demo: identified demonstration, no AI. */
  mode: 'ai' | 'demo'
  notice: string | null
  model: string | null
  sources: { id: string; kind: AssistantSourceKind; title: string; link: string | null }[]
}

/** The backend decides what this profile may see; the question only says what is relevant. */
export function askAssistant(question: string, signal?: AbortSignal): Promise<{ reply: AssistantReply }> {
  return apiRequest('/assistant/ask', { method: 'POST', body: { question }, signal })
}
