/**
 * API client. Tokens live in MEMORY only (never localStorage): an XSS cannot exfiltrate a persisted refresh
 * token, at the cost of re-signing in after a page reload. A cookie-based session is planned for the deployment phase.
 */
export interface HealthResult {
  status: 'ok' | 'degraded'
  checks: { database: { status: string; latencyMs?: number }; redis: { status: string; latencyMs?: number } }
}

export class ApiError extends Error {
  status: number
  code: string
  fields?: Record<string, string>
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}

let accessToken: string | null = null
let refreshToken: string | null = null
let onSessionLost: () => void = () => {}
export const setSessionLostHandler = (fn: () => void) => { onSessionLost = fn }
export const setTokens = (a: string | null, r: string | null) => { accessToken = a; refreshToken = r }

async function raw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (auth && accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  return fetch(`/api/v1${path}`, { ...init, headers })
}

async function refresh(): Promise<boolean> {
  if (!refreshToken) return false
  const res = await raw('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }, false)
  if (!res.ok) return false
  const b = await res.json()
  setTokens(b.accessToken, b.refreshToken)
  return true
}

export async function api<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  let res = await raw(path, init, auth)
  if (res.status === 401 && auth && (await refresh())) res = await raw(path, init, auth)
  if (res.status === 401 && auth) onSessionLost()
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'error', body.message ?? 'Request failed', body.fields)
  return body as T
}

/** Reads API readiness (public endpoint). */
export async function fetchHealth(): Promise<HealthResult> {
  const res = await fetch('/api/v1/health')
  const body = await res.json()
  if (body.checks) return body as HealthResult
  throw new Error('Unexpected health response')
}

export interface Me { id: string; type: 'CUSTOMER' | 'STAFF'; fullName?: string; username: string; permissions?: string[] }
export interface KycItem {
  userId: string; customerNumber: string; fullName: string; email: string; kycStatus: string
  dateOfBirth?: string; nationalIdMasked?: string | null; address?: { line1: string; city: string; postalCode: string }
}
