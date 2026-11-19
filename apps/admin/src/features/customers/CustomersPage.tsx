import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Err, Pill, btn, card, input, statusTone, td, th } from '../../components/ui'
import { useAuth } from '../../auth'
import { formatMinor } from '../../lib/money'
import { api } from '../../services/api'

interface Row { userId: string; customerNumber?: string; fullName?: string; email: string; status: string; kycStatus?: string; createdAt: string }

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export function CustomersPage() {
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState('')
  const [kyc, setKyc] = useState('')
  const q = useDebounced(term)
  const list = useInfiniteQuery({
    queryKey: ['customers', q, status, kyc],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '25' })
      if (q.trim().length >= 2) p.set('q', q.trim())
      if (status) p.set('status', status)
      if (kyc) p.set('kyc', kyc)
      if (pageParam) p.set('cursor', pageParam)
      return api<{ items: Row[]; nextCursor: string | null }>(`/admin/customers?${p}`)
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const rows = list.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <section aria-labelledby="cu-h">
      <h1 id="cu-h" className="mb-4 text-2xl font-semibold">Customers</h1>
      <div className="mb-4 flex flex-wrap gap-3">
        <input aria-label="Search customers" placeholder="Name, customer ID, email or username (2+ characters)" className={`${input} w-96`} value={term} onChange={(e) => setTerm(e.target.value)} />
        <select aria-label="Status" className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>{['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED'].map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ').toLowerCase()}</option>)}
        </select>
        <select aria-label="KYC" className={input} value={kyc} onChange={(e) => setKyc(e.target.value)}>
          <option value="">Any KYC</option>{['NOT_SUBMITTED', 'SUBMITTED', 'MORE_INFO_REQUESTED', 'APPROVED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ').toLowerCase()}</option>)}
        </select>
      </div>
      {list.isPending && <p className="text-muted">Loading…</p>}
      <Err e={list.error} />
      {!list.isPending && rows.length === 0 && <p className="text-muted">No customers match.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-surface ring-1 ring-black/5">
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr>{['Customer', 'Customer ID', 'Email', 'Status', 'KYC', 'Joined'].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-t border-black/5 hover:bg-black/[.03]">
                  <td className={td}><Link className="font-medium text-primary" to={`/customers/${r.userId}`}>{r.fullName ?? '(no name)'}</Link></td>
                  <td className={`${td} font-mono text-xs`}>{r.customerNumber}</td>
                  <td className={td}>{r.email}</td>
                  <td className={td}><Pill tone={statusTone(r.status)}>{r.status.replaceAll('_', ' ').toLowerCase()}</Pill></td>
                  <td className={td}>{r.kycStatus?.replaceAll('_', ' ').toLowerCase()}</td>
                  <td className={`${td} whitespace-nowrap`}>{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && <button className={`${btn} mt-4 bg-primary`} disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
    </section>
  )
}

interface Detail {
  userId: string; customerNumber: string; fullName: string; username: string; email: string; phone: string | null; status: string; createdAt: string
  kyc: { status: string; note: string | null; dateOfBirth: string | null; nationalIdMasked: string | null; address: { line1?: string; city?: string } | null }
  security: { activeSessions: number; failedLogins24h: number; hasPin: boolean; lockedUntil: string | null; recentLogins: { at: string; success: boolean; ip: string | null }[] }
  accounts: { id: string; accountNumber: string; product: string; status: string; balanceMinor: number; currency: string }[]
  cards: { id: string; kind: string; status: string; last4: string | null }[]
  loans: { id: string; reference: string; status: string; principalMinor: number; outstandingMinor: number }[]
  fixedDeposits: { id: string; reference: string; status: string; principalMinor: number; maturityDate: string }[]
  recentPayments: { id: string; reference: string; kind: string; status: string; amountMinor: number; createdAt: string }[]
}

export function CustomerDetailPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api<Detail>(`/admin/customers/${id}`) })
  const [reason, setReason] = useState('')
  const act = useMutation({
    mutationFn: (kind: 'suspend' | 'restore') => api(`/admin/customers/${id}/${kind}`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { setReason(''); qc.invalidateQueries({ queryKey: ['customer', id] }); qc.invalidateQueries({ queryKey: ['customers'] }) },
  })
  const d = q.data
  return (
    <section>
      <Link to="/customers" className="text-sm text-primary">← Customers</Link>
      {q.isPending && <p className="mt-4 text-muted">Loading…</p>}
      <Err e={q.error} />
      {d && (
        <div className="mt-2 space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{d.fullName}</h1>
            <Pill tone={statusTone(d.status)}>{d.status.replaceAll('_', ' ').toLowerCase()}</Pill>
            <span className="font-mono text-sm text-muted">{d.customerNumber}</span>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div className={card}>
              <h2 className="mb-2 font-semibold">Profile & verification</h2>
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
                <dt className="text-muted">Email</dt><dd>{d.email}</dd>
                <dt className="text-muted">Phone</dt><dd>{d.phone ?? '—'}</dd>
                <dt className="text-muted">KYC</dt><dd>{d.kyc.status.replaceAll('_', ' ').toLowerCase()}{d.kyc.note ? ` — ${d.kyc.note}` : ''}</dd>
                <dt className="text-muted">National ID</dt><dd className="font-mono">{d.kyc.nationalIdMasked ?? '—'}</dd>
                <dt className="text-muted">Date of birth</dt><dd>{d.kyc.dateOfBirth ?? '—'}</dd>
                <dt className="text-muted">Address</dt><dd>{d.kyc.address ? `${d.kyc.address.line1}, ${d.kyc.address.city}` : '—'}</dd>
              </dl>
            </div>
            <div className={card}>
              <h2 className="mb-2 font-semibold">Security</h2>
              <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
                <dt className="text-muted">Active sessions</dt><dd>{d.security.activeSessions}</dd>
                <dt className="text-muted">Failed sign-ins (24 h)</dt><dd className={d.security.failedLogins24h > 0 ? 'text-warn' : ''}>{d.security.failedLogins24h}</dd>
                <dt className="text-muted">App PIN set</dt><dd>{d.security.hasPin ? 'Yes' : 'No'}</dd>
                <dt className="text-muted">Locked until</dt><dd>{d.security.lockedUntil ? new Date(d.security.lockedUntil).toLocaleString() : '—'}</dd>
              </dl>
              <ul className="mt-2 text-xs text-muted">{d.security.recentLogins.map((l, i) => <li key={i}>{new Date(l.at).toLocaleString()} · {l.success ? 'signed in' : 'failed'} · {l.ip ?? 'n/a'}</li>)}</ul>
            </div>
          </div>

          <div className={card}>
            <h2 className="mb-2 font-semibold">Accounts</h2>
            {d.accounts.length === 0 ? <p className="text-sm text-muted">No accounts.</p> : (
              <table className="w-full text-left text-sm"><tbody>
                {d.accounts.map((a) => <tr key={a.id} className="border-t border-black/5 first:border-0"><td className="py-2 font-mono">{a.accountNumber}</td><td>{a.product}</td><td><Pill tone={statusTone(a.status)}>{a.status.toLowerCase()}</Pill></td><td className="text-right tabular-nums">{formatMinor(a.balanceMinor, a.currency)}</td></tr>)}
              </tbody></table>
            )}
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <div className={card}><h2 className="mb-2 font-semibold">Cards</h2>{d.cards.length === 0 ? <p className="text-sm text-muted">None</p> : d.cards.map((c) => <div key={c.id} className="text-sm">{c.kind.toLowerCase()} {c.last4 ? `••${c.last4}` : ''} <Pill tone={statusTone(c.status)}>{c.status.replaceAll('_', ' ').toLowerCase()}</Pill></div>)}</div>
            <div className={card}><h2 className="mb-2 font-semibold">Loans</h2>{d.loans.length === 0 ? <p className="text-sm text-muted">None</p> : d.loans.map((l) => <div key={l.id} className="text-sm">{l.reference} · outstanding {formatMinor(l.outstandingMinor)} <Pill tone={statusTone(l.status)}>{l.status.toLowerCase()}</Pill></div>)}</div>
            <div className={card}><h2 className="mb-2 font-semibold">Fixed deposits</h2>{d.fixedDeposits.length === 0 ? <p className="text-sm text-muted">None</p> : d.fixedDeposits.map((f) => <div key={f.id} className="text-sm">{f.reference} · {formatMinor(f.principalMinor)} <Pill tone={statusTone(f.status)}>{f.status.toLowerCase()}</Pill></div>)}</div>
          </div>

          <div className={card}>
            <h2 className="mb-2 font-semibold">Recent payments</h2>
            {d.recentPayments.length === 0 ? <p className="text-sm text-muted">None</p> : (
              <table className="w-full text-left text-sm"><tbody>
                {d.recentPayments.map((p) => <tr key={p.id} className="border-t border-black/5 first:border-0"><td className="py-2 font-mono text-xs">{p.reference}</td><td>{p.kind.replaceAll('_', ' ').toLowerCase()}</td><td>{p.status.toLowerCase()}</td><td className="text-right tabular-nums">{formatMinor(p.amountMinor)}</td></tr>)}
              </tbody></table>
            )}
          </div>

          {can('customers.suspend') && (d.status === 'SUSPENDED' || d.status === 'ACTIVE' || d.status === 'PENDING_VERIFICATION') && (
            <div className={card}>
              <h2 className="mb-2 font-semibold">{d.status === 'SUSPENDED' ? 'Restore access' : 'Suspend access'}</h2>
              <p className="mb-3 text-sm text-muted">{d.status === 'SUSPENDED' ? 'The customer can sign in again. Unverified customers return to pending verification.' : 'The customer is signed out everywhere immediately and cannot sign in until restored. A reason is recorded in the audit log.'}</p>
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label="Reason" placeholder="Reason (required)" className={`${input} min-w-72 flex-1`} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className={`${btn} ${d.status === 'SUSPENDED' ? 'bg-ok' : 'bg-err'}`} disabled={act.isPending || reason.trim().length < 3} onClick={() => act.mutate(d.status === 'SUSPENDED' ? 'restore' : 'suspend')}>{d.status === 'SUSPENDED' ? 'Restore customer' : 'Suspend customer'}</button>
              </div>
              <Err e={act.error} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}
