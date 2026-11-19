import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { btn, card, Err, input, Pill } from '../../components/ui'
import { api } from '../../services/api'

const post = (path: string, body: unknown = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })
const when = (iso: string) => new Date(iso).toLocaleString()

interface Alert {
  id: string; ruleCode: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; summary: string; details: Record<string, unknown>; status: string
  customerName?: string; customerNumber?: string; resolutionNote: string | null; createdAt: string
}
interface Health {
  status: 'OK' | 'ATTENTION'; warnings: string[]; checkedAt: string
  outbox: { pending: number; oldestPendingSeconds: number; failing: number }
  notificationsLast24h: number; scheduledPaymentsOverdue: number; unfinishedPaymentsOverAnHour: number
  queues: { openTickets: number; openDisputes: number }; openRiskAlertsBySeverity: Record<string, number>
}

const RULES: Record<string, string> = {
  HIGH_VALUE: 'High-value payment', VELOCITY: 'Rapid payments', NEW_PAYEE_LARGE: 'Large payment to new recipient',
  NEW_DEVICE_ACTIVITY: 'Large payment after new device', ANOMALY_EXPERIMENT: 'Unusual amount (experimental)',
}
const tone = (s: string) => (s === 'HIGH' ? 'err' : s === 'MEDIUM' ? 'warn' : 'muted') as 'err' | 'warn' | 'muted'

export function RiskPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('OPEN')
  const [note, setNote] = useState<Record<string, string>>({})
  const q = useQuery({ queryKey: ['risk-alerts', status], queryFn: () => api<{ items: Alert[] }>(`/admin/risk/alerts?status=${status}`) })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['risk-alerts'] }) }
  const take = useMutation({ mutationFn: (id: string) => post(`/admin/risk/alerts/${id}/take`), onSuccess: refresh })
  const resolve = useMutation({ mutationFn: (v: { id: string; status: 'CLEARED' | 'ESCALATED' }) => post(`/admin/risk/alerts/${v.id}/resolve`, { status: v.status, note: note[v.id] ?? '' }), onSuccess: refresh })

  return (
    <section aria-labelledby="risk-h">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h1 id="risk-h" className="text-2xl font-semibold">Risk alerts</h1>
        <label className="ml-auto text-sm">Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
            {['OPEN', 'INVESTIGATING', 'CLEARED', 'ESCALATED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      <p className="mb-4 text-sm text-muted">Simulated monitoring rules, not a certified compliance control. An alert never blocks or reverses a payment: a person reviews it and records a decision.</p>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      {q.data?.items.length === 0 && <p className="text-muted">No alerts here.</p>}
      <ul className="space-y-3">
        {q.data?.items.map((a) => (
          <li key={a.id} className={card}>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={tone(a.severity)}>{a.severity.toLowerCase()}</Pill>
              <span className="font-semibold">{RULES[a.ruleCode] ?? a.ruleCode}</span>
              <span className="text-sm text-muted">{a.customerName} · {a.customerNumber} · {when(a.createdAt)}</span>
            </div>
            <p className="mt-1 text-sm">{a.summary}</p>
            <details className="mt-1 text-sm text-muted">
              <summary className="cursor-pointer">Why this was raised</summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
                {Object.entries(a.details).map(([k, v]) => (<div key={k} className="contents"><dt className="font-medium">{k}</dt><dd>{String(v)}</dd></div>))}
              </dl>
            </details>
            {a.resolutionNote && <p className="mt-2 text-sm">Decision note: {a.resolutionNote}</p>}
            {(a.status === 'OPEN' || a.status === 'INVESTIGATING') && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {a.status === 'OPEN' && <button className={`${btn} bg-navy`} disabled={take.isPending} onClick={() => take.mutate(a.id)}>Start investigating</button>}
                <input aria-label={`Decision note for ${a.summary}`} placeholder="Decision note (required)" className={`${input} min-w-64 flex-1`} value={note[a.id] ?? ''} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })} />
                <button className={`${btn} bg-ok`} disabled={resolve.isPending || (note[a.id] ?? '').trim().length < 5} onClick={() => resolve.mutate({ id: a.id, status: 'CLEARED' })}>Clear</button>
                <button className={`${btn} bg-err`} disabled={resolve.isPending || (note[a.id] ?? '').trim().length < 5} onClick={() => resolve.mutate({ id: a.id, status: 'ESCALATED' })}>Escalate</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Err e={take.error ?? resolve.error} />
    </section>
  )
}

export function SystemHealthPage() {
  const q = useQuery({ queryKey: ['ops-health'], queryFn: () => api<Health>('/admin/ops/health'), refetchInterval: 30_000 })
  const h = q.data
  const stat = (label: string, value: string | number) => (
    <div className={card}><div className="text-sm text-muted">{label}</div><div className="mt-1 text-2xl font-semibold">{value}</div></div>
  )
  return (
    <section aria-labelledby="health-h">
      <div className="mb-4 flex items-center gap-3">
        <h1 id="health-h" className="text-2xl font-semibold">System health</h1>
        {h && <Pill tone={h.status === 'OK' ? 'ok' : 'warn'}>{h.status === 'OK' ? 'All clear' : 'Needs attention'}</Pill>}
      </div>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      {h && (<>
        {h.warnings.length > 0 && <ul role="alert" className="mb-4 list-disc space-y-1 pl-5 text-warn">{h.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stat('Notifications waiting', h.outbox.pending)}
          {stat('Oldest waiting (seconds)', h.outbox.oldestPendingSeconds)}
          {stat('Notifications, last 24 h', h.notificationsLast24h)}
          {stat('Scheduled payments overdue', h.scheduledPaymentsOverdue)}
          {stat('Open support requests', h.queues.openTickets)}
          {stat('Open payment problem reports', h.queues.openDisputes)}
          {stat('Open high-severity alerts', h.openRiskAlertsBySeverity.HIGH ?? 0)}
          {stat('Unfinished payments over 1 h', h.unfinishedPaymentsOverAnHour)}
        </div>
        <p className="mt-4 text-xs text-muted">Checked {when(h.checkedAt)}. Refreshes every 30 seconds.</p>
      </>)}
    </section>
  )
}
