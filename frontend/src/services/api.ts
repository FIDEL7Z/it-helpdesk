// Single HTTP client for the backend. VITE_API_URL already includes the /api prefix.
const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api').replace(/\/+$/, '')

const TOKEN_KEY = 'it-helpdesk:token'

/**
 * The token is kept in localStorage (decision for this test). Any script running
 * on the page can read it, so an XSS flaw would expose the session.
 */
export const tokenStorage = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      // Storage unavailable (e.g. blocked by the browser): the session lasts until reload.
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      // Nothing to clear.
    }
  },
}

/** Error returned by the API. `status` is 0 when the server could not be reached. */
export class ApiError extends Error {
  readonly status: number
  /** Stable business code sent by the API for rules the interface explains (e.g. INSUFFICIENT_STOCK). */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

let onUnauthorized: (() => void) | null = null

/** Called when an authenticated request gets 401 (expired, invalid or revoked session). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Send the stored token. Disabled for the login request. */
  auth?: boolean
  signal?: AbortSignal
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function errorMessageFrom(data: unknown, status: number): string {
  if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
    return data.message
  }
  return `Request failed with status ${status}`
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, signal } = options
  const token = auth ? tokenStorage.get() : null

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(0, 'Could not reach the server')
  }

  const data = await readJson(response)

  if (!response.ok) {
    // Only a request that carried a token can invalidate the session. 403 keeps the session.
    if (response.status === 401 && token) {
      tokenStorage.clear()
      onUnauthorized?.()
    }
    const code = typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string' ? data.code : undefined
    throw new ApiError(response.status, errorMessageFrom(data, response.status), code)
  }

  // The response shape is defined by our own API; each caller declares the type it expects.
  return data as T
}
