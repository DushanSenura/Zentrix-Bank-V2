import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useAuth } from '../../auth'
import { api, fetchHealth } from '../../services/api'

function Pill({ label, status, latency }: { label: string; status: string; latency?: number }) {
  const up = status === 'up'
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-black/5"
    >
      <div className="text-sm text-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${up ? 'text-ok' : 'text-err'}`}>{up ? 'Operational' : 'Down'}</div>
      {latency !== undefined && <div className="text-xs text-muted">{latency} ms</div>}
    </motion.div>
  )
}

function Reconciliation() {
  const q = useQuery({ queryKey: ['recon'], queryFn: () => api<{ ok: boolean; mismatches: { code: string }[]; totals: { currency: string; debit: string; credit: string }[] }>('/admin/reconciliation'), refetchInterval: 60_000 })
  if (q.isPending) return <p className="text-muted">Running ledger checks…</p>
  if (q.isError || !q.data) return <p role="alert" className="text-err">Ledger check failed to run.</p>
  return (
    <div className={`rounded-2xl bg-surface p-5 ring-1 ${q.data.ok ? 'ring-ok/40' : 'ring-err/60'}`}>
      <div className="text-sm text-muted">Ledger reconciliation</div>
      <div className={`mt-1 text-xl font-semibold ${q.data.ok ? 'text-ok' : 'text-err'}`}>{q.data.ok ? 'Balanced and consistent' : `${q.data.mismatches.length} mismatch(es)`}</div>
      {q.data.totals.map((t) => <div key={t.currency} className="text-xs text-muted">{t.currency}: debits {t.debit} = credits {t.credit} (minor units)</div>)}
    </div>
  )
}

export default function DashboardPage() {
  const { can } = useAuth()
  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 15_000 })

  return (
    <section aria-labelledby="h">
      <h1 id="h" className="mb-4 text-2xl font-semibold">System status</h1>
      {isPending && <p className="text-muted">Checking services…</p>}
      {isError && (
        <div role="alert" className="rounded-2xl bg-surface p-5 ring-1 ring-err/40">
          <p className="font-medium text-err">The API is unreachable.</p>
          <button onClick={() => refetch()} className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white">Retry</button>
        </div>
      )}
      {data && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Pill label="PostgreSQL" status={data.checks.database.status} latency={data.checks.database.latencyMs} />
          <Pill label="Redis" status={data.checks.redis.status} latency={data.checks.redis.latencyMs} />
          {can('transactions.read') && <Reconciliation />}
        </div>
      )}
    </section>
  )
}
