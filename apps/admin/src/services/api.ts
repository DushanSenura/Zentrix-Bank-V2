export interface HealthResult {
  status: 'ok' | 'degraded'
  checks: { database: { status: string; latencyMs?: number }; redis: { status: string; latencyMs?: number } }
}

/** Reads API readiness. A 503 still carries the degraded body, so it is parsed, not thrown away. */
export async function fetchHealth(): Promise<HealthResult> {
  const res = await fetch('/api/v1/health')
  const body = (await res.json()) as HealthResult | { message?: HealthResult }
  if ('checks' in body) return body
  if (body.message && 'checks' in body.message) return body.message
  throw new Error('Unexpected health response')
}
