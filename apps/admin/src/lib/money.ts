/** Display helper only. Authoritative money lives in the ledger as integer minor units. */
export function formatMinor(minor: number, currency = 'LKR'): string {
  const neg = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.trunc(abs / 100).toLocaleString('en-US')
  const frac = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}${currency} ${whole}.${frac}`
}

/** Parses "2500.50" into 250050 without floating point. Returns null when invalid. */
export function parseMajorToMinor(input: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}
