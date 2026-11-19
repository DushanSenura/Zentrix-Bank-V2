import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth'
import { Err, Pill, btn, card, input } from '../../components/ui'
import { formatMinor, parseMajorToMinor } from '../../lib/money'
import { api } from '../../services/api'

interface Approval {
  id: string; kind: 'PAYMENT_REVERSAL' | 'LEDGER_ADJUSTMENT'; status: string; createdAt: string; requestedBy: string; requestedByName?: string
  subjectId: string; reason: string; reference: string | null; direction: 'CREDIT' | 'DEBIT' | null; amountMinor: number | null
}

/** Reversals and adjustments. A request moves no money; a DIFFERENT staff member must approve it. */
export default function OperationsPage() {
  const { me } = useAuth()
  const qc = useQueryClient()
  const recon = useQuery({ queryKey: ['ledger-recon'], queryFn: () => api<{ ok: boolean; mismatches: { code: string }[]; pendingApprovals: number; totalAdjustmentsMinor: number; totals: { currency: string; debit: string; credit: string }[] }>('/admin/ledger/reconciliation') })
  const list = useQuery({ queryKey: ['ledger-approvals'], queryFn: () => api<{ items: Approval[] }>('/admin/ledger/approvals') })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ledger-approvals'] }); qc.invalidateQueries({ queryKey: ['ledger-recon'] }) }

  const [reason, setReason] = useState<Record<string, string>>({})
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'REJECT' }) => api(`/admin/ledger/approvals/${v.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, reason: reason[v.id] || undefined }) }),
    onSuccess: refresh,
  })

  const [adj, setAdj] = useState({ accountId: '', direction: 'CREDIT', amount: '', reason: '' })
  const [adjErr, setAdjErr] = useState<string | null>(null)
  const [adjOk, setAdjOk] = useState(false)
  const request = useMutation({
    mutationFn: (v: { amountMinor: number }) => api('/admin/ledger/adjustments', { method: 'POST', body: JSON.stringify({ accountId: adj.accountId.trim(), direction: adj.direction, amountMinor: v.amountMinor, reason: adj.reason }) }),
    onSuccess: () => { setAdj({ accountId: '', direction: 'CREDIT', amount: '', reason: '' }); setAdjOk(true); refresh() },
  })
  function submit() {
    setAdjOk(false)
    const m = parseMajorToMinor(adj.amount)
    if (m === null) return setAdjErr('Enter an amount like 1500.00')
    if (!/^[0-9a-f-]{36}$/i.test(adj.accountId.trim())) return setAdjErr('Paste the account ID from the customer page')
    if (adj.reason.trim().length < 3) return setAdjErr('A reason is required')
    setAdjErr(null)
    request.mutate({ amountMinor: m })
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Ledger operations</h1>

      <section aria-labelledby="rc-h" className="mb-8">
        <h2 id="rc-h" className="mb-3 text-xl font-semibold">Reconciliation</h2>
        {recon.isPending && <p className="text-muted">Running ledger checks…</p>}
        <Err e={recon.error} />
        {recon.data && (
          <div className={`${card} ${recon.data.ok ? 'ring-ok/40' : 'ring-err/60'}`}>
            <div className={`text-xl font-semibold ${recon.data.ok ? 'text-ok' : 'text-err'}`}>{recon.data.ok ? 'Ledger balanced and every projection matches its postings' : `${recon.data.mismatches.length} mismatch(es) found`}</div>
            {recon.data.mismatches.map((m) => <div key={m.code} className="font-mono text-xs text-err">{m.code}</div>)}
            {recon.data.totals.map((t) => <div key={t.currency} className="text-sm text-muted">{t.currency}: debits {t.debit} = credits {t.credit} (minor units)</div>)}
            <div className="text-sm text-muted">Net adjustments booked: {formatMinor(recon.data.totalAdjustmentsMinor)}</div>
          </div>
        )}
      </section>

      <section aria-labelledby="ad-h" className="mb-8">
        <h2 id="ad-h" className="mb-3 text-xl font-semibold">Request an adjustment</h2>
        <div className={card}>
          <p className="mb-3 text-sm text-muted">Adjustments post a new journal against a system account — balances are never overwritten. A second approver must approve before anything moves.</p>
          <div className="grid gap-3 md:grid-cols-4">
            <input aria-label="Account ID" placeholder="Account ID (UUID)" className={`${input} md:col-span-2`} value={adj.accountId} onChange={(e) => setAdj({ ...adj, accountId: e.target.value })} />
            <select aria-label="Direction" className={input} value={adj.direction} onChange={(e) => setAdj({ ...adj, direction: e.target.value })}><option value="CREDIT">Credit the customer</option><option value="DEBIT">Debit the customer</option></select>
            <input aria-label="Amount (LKR)" placeholder="Amount (LKR)" className={input} value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} />
            <input aria-label="Adjustment reason" placeholder="Reason (recorded in the audit log)" className={`${input} md:col-span-3`} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
            <button className={`${btn} bg-primary`} disabled={request.isPending} onClick={submit}>Request adjustment</button>
          </div>
          {adjErr && <p role="alert" className="mt-3 text-err">{adjErr}</p>}
          {adjOk && <p role="status" className="mt-3 text-ok">Request created. It now needs a second person's approval.</p>}
          <Err e={request.error} />
        </div>
      </section>

      <section aria-labelledby="aq-h">
        <h2 id="aq-h" className="mb-1 text-xl font-semibold">Waiting for approval</h2>
        <p className="mb-3 text-sm text-muted">Reversals are requested from the Transactions page.</p>
        {list.isPending && <p className="text-muted">Loading…</p>}
        <Err e={list.error} />
        {list.data?.items.length === 0 && <p className="text-muted">Nothing is waiting.</p>}
        <ul className="space-y-3">
          {list.data?.items.map((a) => {
            const mine = a.requestedBy === me?.id
            return (
              <li key={a.id} className={card}>
                <div className="font-semibold">
                  {a.kind === 'PAYMENT_REVERSAL' ? `Reverse payment ${a.reference}` : `${a.direction === 'CREDIT' ? 'Credit' : 'Debit'} account`} · {a.amountMinor !== null && formatMinor(a.amountMinor)} <Pill>{a.kind === 'PAYMENT_REVERSAL' ? 'reversal' : 'adjustment'}</Pill>
                </div>
                <div className="text-sm text-muted">Requested by {a.requestedByName ?? 'staff'} · “{a.reason}”</div>
                {mine && <div className="mt-2 text-sm text-warn">You requested this, so another approver must decide it.</div>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button className={`${btn} bg-ok`} disabled={decide.isPending || mine} onClick={() => decide.mutate({ id: a.id, decision: 'APPROVE' })}>Approve</button>
                  <input aria-label="Rejection reason" placeholder="Reason (required to reject)" className={`${input} min-w-56 flex-1`} value={reason[a.id] ?? ''} onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} />
                  <button className={`${btn} bg-err`} disabled={decide.isPending || mine} onClick={() => decide.mutate({ id: a.id, decision: 'REJECT' })}>Reject</button>
                </div>
              </li>
            )
          })}
        </ul>
        <Err e={decide.error} />
      </section>
    </div>
  )
}
