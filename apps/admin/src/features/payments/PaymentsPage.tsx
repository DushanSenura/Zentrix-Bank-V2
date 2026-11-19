import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { formatMinor } from '../../lib/money'
import { api, ApiError } from '../../services/api'

export interface AdminPayment {
  id: string; reference: string; kind: string; status: string; amountMinor: number; feeMinor: number; currency: string
  recipient: { name: string; bank: string; accountMasked: string }; customerName?: string; customerNumber?: string
  createdAt: string; postedAt: string | null; failureCode: string | null
}

const STATUSES = ['', 'POSTED', 'AUTHORIZED', 'AWAITING_AUTHORIZATION', 'FAILED', 'CANCELLED', 'REVERSED']
const tone: Record<string, string> = { POSTED: 'text-ok', FAILED: 'text-err', AUTHORIZED: 'text-primary', CANCELLED: 'text-muted' }

/** Read-only monitoring. Money can only be changed through the ledger (reversals arrive with maker-checker in a later phase). */
export default function PaymentsPage() {
  const [status, setStatus] = useState('')
  const q = useQuery({
    queryKey: ['admin-payments', status],
    queryFn: () => api<{ items: AdminPayment[] }>(`/admin/payments${status ? `?status=${status}` : ''}`),
    refetchInterval: 15_000,
  })
  return (
    <section aria-labelledby="pay-h">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 id="pay-h" className="text-2xl font-semibold">Transaction monitoring</h1>
        <label className="ml-auto text-sm">Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-black/15 bg-surface px-2 py-1.5">
            {STATUSES.map((s) => <option key={s} value={s}>{s === '' ? 'All' : s.replaceAll('_', ' ').toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      {q.isPending && <p className="text-muted">Loading…</p>}
      {q.isError && <p role="alert" className="text-err">{q.error instanceof ApiError ? q.error.message : 'Failed to load'}</p>}
      {q.data?.items.length === 0 && <p className="text-muted">No payments match.</p>}
      {q.data && q.data.items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-surface ring-1 ring-black/5">
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr>
              {['When', 'Reference', 'Customer', 'Recipient', 'Type', 'Amount', 'Fee', 'Status'].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {q.data.items.map((p) => (
                <tr key={p.id} className="border-t border-black/5">
                  <td className="px-4 py-3 whitespace-nowrap">{new Date(p.postedAt ?? p.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-xs">{p.reference}</td>
                  <td className="px-4 py-3">{p.customerName}<div className="text-xs text-muted">{p.customerNumber}</div></td>
                  <td className="px-4 py-3">{p.recipient.name}<div className="text-xs text-muted">{p.recipient.bank} · {p.recipient.accountMasked}</div></td>
                  <td className="px-4 py-3">{p.kind.replaceAll('_', ' ').toLowerCase()}</td>
                  <td className="px-4 py-3 tabular-nums">{formatMinor(p.amountMinor, p.currency)}</td>
                  <td className="px-4 py-3 tabular-nums">{p.feeMinor ? formatMinor(p.feeMinor, p.currency) : '—'}</td>
                  <td className={`px-4 py-3 font-medium ${tone[p.status] ?? ''}`}>{p.status.replaceAll('_', ' ').toLowerCase()}{p.failureCode ? <div className="text-xs font-normal text-muted">{p.failureCode}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
