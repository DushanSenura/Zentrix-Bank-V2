import { ApiError } from '../services/api'

/** Shared look so every admin page reads the same. */
export const input = 'rounded-lg border border-black/15 bg-surface px-3 py-1.5 text-sm'
export const card = 'rounded-2xl bg-surface p-5 ring-1 ring-black/5'
export const btn = 'rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60'
export const th = 'px-4 py-3 font-medium'
export const td = 'px-4 py-2'

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Request failed')

export function Err({ e }: { e: unknown }) {
  return e ? <p role="alert" className="mt-3 text-err">{errMsg(e)}</p> : null
}

export function Pill({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'err' | 'muted' }) {
  const c = tone === 'ok' ? 'bg-ok/15 text-ok' : tone === 'warn' ? 'bg-warn/20 text-warn' : tone === 'err' ? 'bg-err/15 text-err' : 'bg-black/5 text-muted'
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{children}</span>
}

export const statusTone = (s: string): 'ok' | 'warn' | 'err' | 'muted' =>
  ['ACTIVE', 'APPROVED', 'POSTED'].includes(s) ? 'ok' : ['SUSPENDED', 'BLOCKED', 'REJECTED', 'FAILED', 'CLOSED'].includes(s) ? 'err' : ['PENDING_VERIFICATION', 'SUBMITTED', 'MORE_INFO_REQUESTED', 'FROZEN'].includes(s) ? 'warn' : 'muted'
