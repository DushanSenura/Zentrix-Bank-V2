import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth'
import { formatMinor, parseMajorToMinor } from '../../lib/money'
import { api, ApiError } from '../../services/api'

interface AppItem {
  id: string; productName: string; minOpeningMinor: number; customerName: string; customerNumber: string; kycStatus: string; nickname?: string | null; createdAt: string
}
interface AccountItem {
  id: string; accountNumber: string; productName: string; status: string; balanceMinor: number; currency: string; customerName: string; customerNumber: string
}

const TRANSITIONS: Record<string, string[]> = {
  ACTIVE: ['FROZEN', 'SUSPENDED', 'CLOSED'], FROZEN: ['ACTIVE', 'SUSPENDED', 'CLOSED'], SUSPENDED: ['ACTIVE', 'CLOSED'], CLOSED: [],
}
const input = 'rounded-lg border border-line bg-surface px-3 py-1.5 text-sm'
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Request failed')

function Applications() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['acc-apps'], queryFn: () => api<{ items: AppItem[] }>('/admin/account-applications') })
  const [deposit, setDeposit] = useState<Record<string, string>>({})
  const [reason, setReason] = useState<Record<string, string>>({})
  const [localErr, setLocalErr] = useState<string | null>(null)
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'REJECT'; openingDepositMinor?: number }) =>
      api(`/admin/account-applications/${v.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, reason: reason[v.id] || undefined, openingDepositMinor: v.openingDepositMinor }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['acc-apps'] }),
  })

  function approve(a: AppItem) {
    const minor = parseMajorToMinor(deposit[a.id] ?? '')
    if (minor === null) return setLocalErr('Enter the cash received as an amount like 2500.00')
    setLocalErr(null)
    decide.mutate({ id: a.id, decision: 'APPROVE', openingDepositMinor: minor })
  }

  return (
    <section aria-labelledby="apps-h" className="mb-10">
      <h2 id="apps-h" className="mb-3 text-xl font-semibold">Account applications</h2>
      {q.isPending && <p className="text-muted">Loading…</p>}
      {q.isError && <p role="alert" className="text-err">{errMsg(q.error)}</p>}
      {q.data?.items.length === 0 && <p className="text-muted">No applications are waiting.</p>}
      <ul className="space-y-3">
        {q.data?.items.map((a) => (
          <li key={a.id} className="rounded-2xl bg-surface p-5 ring-1 ring-black/5">
            <div className="font-semibold">{a.productName}{a.nickname ? ` · “${a.nickname}”` : ''} <span className="text-sm font-normal text-muted">for {a.customerName} ({a.customerNumber}) · KYC {a.kycStatus}</span></div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input aria-label="Opening deposit received (LKR)" placeholder={`Cash received, min ${formatMinor(a.minOpeningMinor)}`} className={`${input} w-64`} value={deposit[a.id] ?? ''} onChange={(e) => setDeposit({ ...deposit, [a.id]: e.target.value })} />
              <button className="rounded-lg bg-ok px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60" disabled={decide.isPending} onClick={() => approve(a)}>Approve & open</button>
              <input aria-label="Rejection reason" placeholder="Reason (required to reject)" className={`${input} min-w-56 flex-1`} value={reason[a.id] ?? ''} onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} />
              <button className="rounded-lg bg-err px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: 'REJECT' })}>Reject</button>
            </div>
          </li>
        ))}
      </ul>
      {(localErr || decide.isError) && <p role="alert" className="mt-3 text-err">{localErr ?? errMsg(decide.error)}</p>}
    </section>
  )
}

function Lookup() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [term, setTerm] = useState('')
  const [active, setActive] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const q = useQuery({ queryKey: ['acc-search', active], queryFn: () => api<{ items: AccountItem[] }>(`/admin/accounts?q=${encodeURIComponent(active)}`), enabled: active.length >= 3 })
  const change = useMutation({
    mutationFn: (v: { id: string; status: string }) => api(`/admin/accounts/${v.id}/status`, { method: 'POST', body: JSON.stringify({ status: v.status, reasonCode }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['acc-search'] }),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); setActive(term.trim()) }
  return (
    <section aria-labelledby="lk-h">
      <h2 id="lk-h" className="mb-3 text-xl font-semibold">Account lookup</h2>
      <form onSubmit={submit} className="mb-3 flex gap-2">
        <input aria-label="Search accounts" placeholder="Account no., customer ID or name (3+ characters)" className={`${input} w-96`} value={term} onChange={(e) => setTerm(e.target.value)} />
        <button className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white">Search</button>
      </form>
      {q.isError && <p role="alert" className="text-err">{errMsg(q.error)}</p>}
      {q.data?.items.length === 0 && <p className="text-muted">No matching accounts.</p>}
      {can('accounts.manage') && q.data && q.data.items.length > 0 && (
        <input aria-label="Reason code" placeholder="Reason code for status changes (required)" className={`${input} mb-3 w-96`} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} />
      )}
      <ul className="space-y-3">
        {q.data?.items.map((a) => (
          <li key={a.id} className="rounded-2xl bg-surface p-5 ring-1 ring-black/5">
            <div className="font-semibold">{a.accountNumber} · {a.productName} <span className="text-sm font-normal text-muted">{a.customerName} ({a.customerNumber})</span></div>
            <div className="mt-1 text-sm">Status <b>{a.status}</b> · Ledger balance <b>{formatMinor(a.balanceMinor, a.currency)}</b></div>
            {can('accounts.manage') && (
              <div className="mt-3 flex flex-wrap gap-2">
                {TRANSITIONS[a.status]?.map((to) => (
                  <button key={to} disabled={change.isPending || reasonCode.trim().length < 3} onClick={() => change.mutate({ id: a.id, status: to })}
                    className="rounded-lg bg-navy px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{to === 'ACTIVE' ? 'Activate' : to[0] + to.slice(1).toLowerCase()}</button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {change.isError && <p role="alert" className="mt-3 text-err">{errMsg(change.error)}</p>}
    </section>
  )
}

export default function AccountsPage() {
  const { can } = useAuth()
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Accounts</h1>
      {can('accounts.review') && <Applications />}
      {can('customers.read') && <Lookup />}
    </div>
  )
}
