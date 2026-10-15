import { apiRequest } from './api'
import type { Pagination, TicketCategory } from './tickets'

export type ArticleStatus = 'draft' | 'published' | 'archived'

export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
  draft: 'Rascunho',
  published: 'Publicado',
  archived: 'Arquivado',
}

/** Same limits as the backend; the API enforces them. */
export const ARTICLE_LIMITS = { titleMin: 5, titleMax: 120, summaryMin: 10, summaryMax: 240, bodyMin: 30, bodyMax: 10000 } as const

export type Article = {
  id: string
  title: string
  summary: string
  category: TicketCategory
  body?: string
  updatedAt: string
  myFeedback?: boolean | null
}

/** Team view (kb:manage). */
export type ManagedArticle = Article & {
  status: ArticleStatus
  revision: number
  createdBy: { id: string; name: string } | null
  updatedBy: { id: string; name: string } | null
  publishedAt: string | null
  createdAt: string
  dataOrigin: 'operational' | 'demo'
  helpfulCount: number
  notHelpfulCount: number
}

export type ArticleInput = {
  title: string
  summary: string
  category: TicketCategory
  body: string
  status: ArticleStatus
}

type SearchParams = { q?: string; category?: TicketCategory; status?: ArticleStatus; page?: number; limit?: number }

function query(params: SearchParams): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function searchArticles(params: SearchParams, signal?: AbortSignal): Promise<{ articles: Article[]; pagination: Pagination }> {
  return apiRequest(`/articles${query(params)}`, { signal })
}

export function getArticle(id: string, signal?: AbortSignal): Promise<{ article: Article | ManagedArticle }> {
  return apiRequest(`/articles/${encodeURIComponent(id)}`, { signal })
}

export function sendArticleFeedback(id: string, helpful: boolean): Promise<{ myFeedback: boolean }> {
  return apiRequest(`/articles/${encodeURIComponent(id)}/feedback`, { method: 'PUT', body: { helpful } })
}

export function searchManagedArticles(params: SearchParams, signal?: AbortSignal): Promise<{ articles: ManagedArticle[]; pagination: Pagination }> {
  return apiRequest(`/articles/manage${query(params)}`, { signal })
}

export function createArticle(input: ArticleInput): Promise<{ article: ManagedArticle }> {
  return apiRequest('/articles', { method: 'POST', body: input })
}

export function updateArticle(id: string, input: Partial<ArticleInput>, expectedRevision: number): Promise<{ article: ManagedArticle }> {
  return apiRequest(`/articles/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...input, expectedRevision } })
}

export function isManagedArticle(article: Article | ManagedArticle): article is ManagedArticle {
  return 'status' in article
}
