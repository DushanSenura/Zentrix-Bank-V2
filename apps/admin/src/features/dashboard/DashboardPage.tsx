import { useQuery } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { motion } from 'motion/react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth'
import { formatMinor } from '../../lib/money'
import { api, ApiError, fetchHealth } from '../../services/api'

const VolumeChart = lazy(() => import('./VolumeChart'))

interface Dashboard {
  generatedAt: string
  customers?: { total: number; active: number; pendingKyc: number; suspended: number }
  finance?: {
    depositLiabilitiesMinor: number; loanBalancesMinor: number
    today: { transfers: number; volumeMinor: number; feesMinor: number; failed: number }
    series: { day: string; count: number; volumeMinor: number }[]
  }
  pending: Record<string, number>
  recentAudit?: { id: string; action: string; actorType: string; subjectType: string | null; createdAt: string }[]
  securityAlerts24h?: number
}

const QUEUES: { key: string; label: string; to: string }[] = [
  { key: 'kyc', label: 'KYC reviews', to: '/kyc' }, { key: 'accounts', label: 'Account applications', to: '/accounts' }, { key: 'cards', label: 'Card requests', to: '/cards' },
  { key: 'loanApplications', label: 'Loan applications', to: '/loans' }, { key: 'loanApprovals', label: 'Loan approvals', to: '/loans' },
  { key: 'depositClosures', label: 'Deposit closures', to: '/deposits' }, { key: 'ledgerApprovals', label: 'Ledger approvals', to: '/operations' },
]

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'ok' | 'err' }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-black/5">
      <div className="text-sm text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'err' ? 'text-err' : tone === 'ok' ? 'text-ok' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </motion.div>
  )
}

function Health() {
  const { data, isPending, isError } = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 15_000 })
  if (isPending) return <Kpi label="Services" value="Checking…" />
  if (isError || !data) return <Kpi label="Services" value="API unreachable" tone="err" />
  const ok = data.status === 'ok'
  return <Kpi label="Services" value={ok ? 'Operational' : 'Degraded'} tone={ok ? 'ok' : 'err'} sub={`DB ${data.checks.database.status} · Redis ${data.checks.redis.status}`} />
}

function Reconciliation() {
  const q = useQuery({ queryKey: ['recon'], queryFn: () => api<{ ok: boolean; mismatches: unknown[]; pendingApprovals: number }>('/admin/ledger/reconciliation'), refetchInterval: 60_000 })
  if (q.isPending) return <Kpi label="Ledger reconciliation" value="Running…" />
  if (q.isError || !q.data) return <Kpi label="Ledger reconciliation" value="Failed to run" tone="err" />
  return <Kpi label="Ledger reconciliation" value={q.data.ok ? 'Balanced' : `${q.data.mismatches.length} mismatch(es)`} tone={q.data.ok ? 'ok' : 'err'} sub={`${q.data.pendingApprovals} approval(s) pending`} />
}

export default function DashboardPage() {
  const { can } = useAuth()
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/admin/dashboard'), refetchInterval: 30_000 })
  const d = q.data
  const queues = d ? QUEUES.filter((x) => d.pending[x.key] !== undefined) : []

  return (
    <section aria-labelledby="dash-h">
      <h1 id="dash-h" className="mb-4 text-2xl font-semibold">Dashboard</h1>
      {q.isPending && <p className="text-muted">Loading…</p>}
      {q.isError && <p role="alert" className="text-err">{q.error instanceof ApiError ? q.error.message : 'Could not load the dashboard'}</p>}
      {d && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {d.customers && (<>
              <Kpi label="Customers" value={d.customers.total.toLocaleString()} sub={`${d.customers.active.toLocaleString()} active · ${d.customers.suspended} suspended`} />
              <Kpi label="Pending KYC" value={d.customers.pendingKyc} />
            </>)}
            {d.finance && (<>
              <Kpi label="Deposit liabilities" value={formatMinor(d.finance.depositLiabilitiesMinor)} sub="All customer, deposit and goal balances" />
              <Kpi label="Loan balances" value={formatMinor(d.finance.loanBalancesMinor)} sub="Outstanding principal" />
              <Kpi label="Transfers today" value={d.finance.today.transfers.toLocaleString()} sub={`${formatMinor(d.finance.today.volumeMinor)} · fees ${formatMinor(d.finance.today.feesMinor)}`} />
              <Kpi label="Failed today" value={d.finance.today.failed} tone={d.finance.today.failed > 0 ? 'err' : undefined} />
            </>)}
            {d.securityAlerts24h !== undefined && <Kpi label="High-severity security events (24 h)" value={d.securityAlerts24h} tone={d.securityAlerts24h > 0 ? 'err' : 'ok'} />}
            <Health />
            {can('transactions.read') && <Reconciliation />}
          </div>

          {queues.length > 0 && (
            <div>
              <h2 className="mb-2 text-lg font-semibold">Waiting for you</h2>
              <ul className="flex flex-wrap gap-3">
                {queues.map((x) => (
                  <li key={x.key}><Link to={x.to} className="flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-sm ring-1 ring-black/10 hover:ring-primary"><b className={d.pending[x.key]! > 0 ? 'text-primary' : 'text-muted'}>{d.pending[x.key]}</b> {x.label}</Link></li>
                ))}
              </ul>
            </div>
          )}

          {d.finance && (
            <div className="rounded-2xl bg-surface p-5 ring-1 ring-black/5">
              <h2 className="mb-3 text-lg font-semibold">Transfer volume, last 14 days</h2>
              {d.finance.series.length === 0 ? <p className="text-muted">No transfers in this period.</p> : (
                <Suspense fallback={<p role="status" className="text-muted">Loading chart…</p>}><VolumeChart series={d.finance.series} /></Suspense>
              )}
            </div>
          )}

          {d.recentAudit && (
            <div className="rounded-2xl bg-surface p-5 ring-1 ring-black/5">
              <div className="mb-2 flex items-center"><h2 className="text-lg font-semibold">Recent activity</h2><Link to="/audit" className="ml-auto text-sm text-primary">Open audit log</Link></div>
              <ul className="divide-y divide-black/5 text-sm">
                {d.recentAudit.map((a) => <li key={a.id} className="flex gap-3 py-2"><span className="w-40 shrink-0 text-muted">{new Date(a.createdAt).toLocaleString()}</span><span className="font-mono text-xs">{a.action}</span><span className="ml-auto text-muted">{a.actorType.toLowerCase()}</span></li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
