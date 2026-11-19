import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, ApiError, type KycItem } from '../../services/api'

export default function KycPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['kyc'], queryFn: () => api<{ items: KycItem[] }>('/admin/kyc') })
  const [reason, setReason] = useState<Record<string, string>>({})
  const decide = useMutation({
    mutationFn: (v: { userId: string; decision: 'APPROVE' | 'REJECT' | 'REQUEST_INFO' }) =>
      api(`/admin/kyc/${v.userId}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, reason: reason[v.userId] || undefined }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kyc'] }),
  })
  const btn = 'rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60'
  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">KYC review queue</h1>
      {q.isPending && <p className="text-muted">Loading…</p>}
      {q.isError && <p role="alert" className="text-err">{q.error instanceof ApiError ? q.error.message : 'Failed to load'}</p>}
      {q.data?.items.length === 0 && <p className="text-muted">No submissions are waiting for review.</p>}
      <ul className="space-y-3">
        {q.data?.items.map((k) => (
          <li key={k.userId} className="rounded-2xl bg-surface p-5 ring-1 ring-black/5">
            <div className="font-semibold">{k.fullName} <span className="text-sm font-normal text-muted">{k.customerNumber} · {k.email}</span></div>
            <div className="mt-1 text-sm text-muted">ID {k.nationalIdMasked} · DOB {k.dateOfBirth} · {k.address?.line1}, {k.address?.city}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input aria-label="Reason" placeholder="Reason (required to reject / request info)" className="min-w-64 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm"
                value={reason[k.userId] ?? ''} onChange={(e) => setReason({ ...reason, [k.userId]: e.target.value })} />
              <button className={`${btn} bg-ok`} disabled={decide.isPending} onClick={() => decide.mutate({ userId: k.userId, decision: 'APPROVE' })}>Approve</button>
              <button className={`${btn} bg-warn`} disabled={decide.isPending} onClick={() => decide.mutate({ userId: k.userId, decision: 'REQUEST_INFO' })}>Request info</button>
              <button className={`${btn} bg-err`} disabled={decide.isPending} onClick={() => decide.mutate({ userId: k.userId, decision: 'REJECT' })}>Reject</button>
            </div>
          </li>
        ))}
      </ul>
      {decide.isError && <p role="alert" className="mt-3 text-err">{decide.error instanceof ApiError ? decide.error.message : 'Decision failed'}</p>}
    </section>
  )
}
