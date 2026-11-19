import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth'
import { formatMinor, parseMajorToMinor } from '../../lib/money'
import { api, ApiError } from '../../services/api'

const input = 'rounded-lg border border-line bg-surface px-3 py-1.5 text-sm'
const card = 'rounded-2xl bg-surface p-5 ring-1 ring-black/5'
const btn = 'rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60'
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Request failed')

function Err({ e }: { e: unknown }) {
  return e ? <p role="alert" className="mt-3 text-err">{errMsg(e)}</p> : null
}

// ═════════════════════════ cards ═════════════════════════
interface CardItem {
  id: string; kind: string; status: string; createdAt: string; customerName?: string; customerNumber?: string
  collectionBranch?: string | null; application?: { monthlyIncomeMinor?: number; employment?: string; requestedLimitMinor?: number } | null; replacement: boolean; last4: string | null
}

export function CardsAdminPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('PENDING_APPROVAL')
  const q = useQuery({ queryKey: ['admin-cards', status], queryFn: () => api<{ items: CardItem[] }>(`/admin/cards?status=${status}`) })
  const [reason, setReason] = useState<Record<string, string>>({})
  const [limit, setLimit] = useState<Record<string, string>>({})
  const [localErr, setLocalErr] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-cards'] })
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'REJECT'; creditLimitMinor?: number }) =>
      api(`/admin/cards/${v.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, reason: reason[v.id] || undefined, creditLimitMinor: v.creditLimitMinor }) }),
    onSuccess: refresh,
  })
  const block = useMutation({
    mutationFn: (id: string) => api(`/admin/cards/${id}/block`, { method: 'POST', body: JSON.stringify({ reason: reason[id] ?? '' }) }),
    onSuccess: refresh,
  })

  function approve(c: CardItem) {
    let creditLimitMinor: number | undefined
    if (c.kind === 'CREDIT') {
      const m = parseMajorToMinor(limit[c.id] ?? '')
      if (m === null) return setLocalErr('Set a credit limit (e.g. 150000.00) to approve a credit card')
      creditLimitMinor = m
    }
    setLocalErr(null)
    decide.mutate({ id: c.id, decision: 'APPROVE', creditLimitMinor })
  }

  return (
    <section aria-labelledby="cards-h">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 id="cards-h" className="text-2xl font-semibold">Card requests</h1>
        <label className="ml-auto text-sm">Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
            {['PENDING_APPROVAL', 'PREPARING', 'READY_TO_COLLECT', 'ACTIVE', 'FROZEN', 'BLOCKED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ').toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      {q.data?.items.length === 0 && <p className="text-muted">Nothing in this queue.</p>}
      <ul className="space-y-3">
        {q.data?.items.map((c) => (
          <li key={c.id} className={card}>
            <div className="font-semibold">{c.kind.toLowerCase()} card{c.replacement ? ' (replacement)' : ''} <span className="text-sm font-normal text-muted">{c.customerName} · {c.customerNumber}{c.last4 ? ` · ••${c.last4}` : ''}</span></div>
            {c.collectionBranch && <div className="text-sm text-muted">Collect at {c.collectionBranch}</div>}
            {c.application?.employment && <div className="text-sm text-muted">Income {formatMinor(c.application.monthlyIncomeMinor ?? 0)} · {c.application.employment} · requested limit {formatMinor(c.application.requestedLimitMinor ?? 0)}</div>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input aria-label="Reason" placeholder="Reason (required to reject or block)" className={`${input} min-w-64 flex-1`} value={reason[c.id] ?? ''} onChange={(e) => setReason({ ...reason, [c.id]: e.target.value })} />
              {status === 'PENDING_APPROVAL' && (<>
                {c.kind === 'CREDIT' && <input aria-label="Credit limit (LKR)" placeholder="Credit limit (LKR)" className={`${input} w-40`} value={limit[c.id] ?? ''} onChange={(e) => setLimit({ ...limit, [c.id]: e.target.value })} />}
                <button className={`${btn} bg-ok`} disabled={decide.isPending} onClick={() => approve(c)}>Approve</button>
                <button className={`${btn} bg-err`} disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, decision: 'REJECT' })}>Reject</button>
              </>)}
              {['PREPARING', 'READY_TO_COLLECT', 'ACTIVE', 'FROZEN', 'PENDING_APPROVAL'].includes(status) && <button className={`${btn} bg-navy`} disabled={block.isPending || (reason[c.id] ?? '').trim().length < 3} onClick={() => block.mutate(c.id)}>Block</button>}
            </div>
          </li>
        ))}
      </ul>
      {localErr && <p role="alert" className="mt-3 text-err">{localErr}</p>}
      <Err e={decide.error ?? block.error} />
    </section>
  )
}

// ═════════════════════════ loans ═════════════════════════
interface LoanApp {
  id: string; status: string; productName?: string; rateBps?: number; amountMinor: number; termMonths: number; monthlyIncomeMinor: number; employment: string; purpose?: string | null
  customerName?: string; customerNumber?: string; kycStatus?: string; assessment?: { band?: string; incomeShareBps?: number; emiMinor?: string }; approvalRequestId?: string | null
}
interface Approval { id: string; requestedBy: string; requestedByName?: string; customerName?: string; terms: { amountMinor: string; termMonths: number; rateBps: number; conditions?: string | null } }

export function LoansAdminPage() {
  const { me, can } = useAuth()
  const qc = useQueryClient()
  const apps = useQuery({ queryKey: ['loan-apps'], queryFn: async () => {
    const [a, b] = await Promise.all([api<{ items: LoanApp[] }>('/admin/loan-applications?status=SUBMITTED'), api<{ items: LoanApp[] }>('/admin/loan-applications?status=UNDER_REVIEW')])
    return [...a.items, ...b.items]
  }, enabled: can('loans.review') })
  const approvals = useQuery({ queryKey: ['loan-approvals'], queryFn: () => api<{ items: Approval[] }>('/admin/loan-approvals'), enabled: can('loans.approve') })
  const [reason, setReason] = useState<Record<string, string>>({})
  const refresh = () => { qc.invalidateQueries({ queryKey: ['loan-apps'] }); qc.invalidateQueries({ queryKey: ['loan-approvals'] }) }
  const recommend = useMutation({ mutationFn: (id: string) => api(`/admin/loan-applications/${id}/recommend`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: refresh })
  const reject = useMutation({ mutationFn: (id: string) => api(`/admin/loan-applications/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason[id] ?? '' }) }), onSuccess: refresh })
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'REJECT' }) => api(`/admin/loan-approvals/${v.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, reason: reason[v.id] || undefined }) }),
    onSuccess: refresh,
  })
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Loans</h1>
      {can('loans.review') && (
        <section aria-labelledby="la-h" className="mb-10">
          <h2 id="la-h" className="mb-3 text-xl font-semibold">Applications</h2>
          <p className="mb-3 text-sm text-muted">Recommending creates an approval request. A different staff member must approve it before any money moves.</p>
          {apps.isPending && <p className="text-muted">Loading…</p>}
          <Err e={apps.error} />
          {apps.data?.length === 0 && <p className="text-muted">No applications to review.</p>}
          <ul className="space-y-3">
            {apps.data?.map((a) => (
              <li key={a.id} className={card}>
                <div className="font-semibold">{a.productName} · {formatMinor(a.amountMinor)} over {a.termMonths} months <span className="text-sm font-normal text-muted">{a.customerName} ({a.customerNumber}) · KYC {a.kycStatus}</span></div>
                <div className="text-sm text-muted">Income {formatMinor(a.monthlyIncomeMinor)} · {a.employment}{a.purpose ? ` · ${a.purpose}` : ''}{a.assessment?.band ? ` · affordability ${a.assessment.band.toLowerCase()} (${((a.assessment.incomeShareBps ?? 0) / 100).toFixed(1)}% of income)` : ''}</div>
                {a.status === 'UNDER_REVIEW' ? <div className="mt-2 text-sm text-primary">Recommended — waiting for a second approver</div> : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button className={`${btn} bg-primary`} disabled={recommend.isPending} onClick={() => recommend.mutate(a.id)}>Recommend approval</button>
                    <input aria-label="Reason" placeholder="Reason (required to reject)" className={`${input} min-w-56 flex-1`} value={reason[a.id] ?? ''} onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} />
                    <button className={`${btn} bg-err`} disabled={reject.isPending} onClick={() => reject.mutate(a.id)}>Reject</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Err e={recommend.error ?? reject.error} />
        </section>
      )}
      {can('loans.approve') && (
        <section aria-labelledby="ap-h">
          <h2 id="ap-h" className="mb-3 text-xl font-semibold">Approvals (second signature)</h2>
          {approvals.isPending && <p className="text-muted">Loading…</p>}
          <Err e={approvals.error} />
          {approvals.data?.items.length === 0 && <p className="text-muted">No approvals are waiting.</p>}
          <ul className="space-y-3">
            {approvals.data?.items.map((r) => {
              const mine = r.requestedBy === me?.id
              return (
                <li key={r.id} className={card}>
                  <div className="font-semibold">{formatMinor(Number(r.terms.amountMinor))} · {r.terms.termMonths} months · {(r.terms.rateBps / 100).toFixed(2)}% <span className="text-sm font-normal text-muted">{r.customerName} · recommended by {r.requestedByName ?? 'staff'}</span></div>
                  {r.terms.conditions && <div className="text-sm text-muted">Conditions: {r.terms.conditions}</div>}
                  {mine && <div className="mt-2 text-sm text-warn">You recommended this loan, so another approver must decide it.</div>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button className={`${btn} bg-ok`} disabled={decide.isPending || mine} onClick={() => decide.mutate({ id: r.id, decision: 'APPROVE' })}>Approve & disburse</button>
                    <input aria-label="Reason" placeholder="Reason (required to reject)" className={`${input} min-w-56 flex-1`} value={reason[r.id] ?? ''} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} />
                    <button className={`${btn} bg-err`} disabled={decide.isPending || mine} onClick={() => decide.mutate({ id: r.id, decision: 'REJECT' })}>Reject</button>
                  </div>
                </li>
              )
            })}
          </ul>
          <Err e={decide.error} />
        </section>
      )}
    </div>
  )
}

// ═════════════════════════ fixed deposits ═════════════════════════
interface Closure { id: string; reference: string; customerName?: string; reason?: string | null; principalMinor: number; estimate: { interestMinor: number; penaltyMinor: number; payoutMinor: number } }
interface RateRow { termMonths: number; rateBps: number; minAmountMinor: number; active: boolean }

export function DepositsAdminPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const closures = useQuery({ queryKey: ['fd-closures'], queryFn: () => api<{ items: Closure[] }>('/admin/fixed-deposit-closures') })
  const rates = useQuery({ queryKey: ['fd-rates'], queryFn: () => api<{ items: RateRow[] }>('/admin/fixed-deposit-rates') })
  const [reason, setReason] = useState<Record<string, string>>({})
  const [edit, setEdit] = useState<Record<number, string>>({})
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'APPROVE' | 'REJECT' }) => api(`/admin/fixed-deposit-closures/${v.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, reason: reason[v.id] || undefined }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fd-closures'] }),
  })
  const setRate = useMutation({
    mutationFn: (v: { termMonths: number; rateBps: number; active?: boolean }) => api('/admin/fixed-deposit-rates', { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fd-rates'] }),
  })
  const [rateErr, setRateErr] = useState<string | null>(null)
  function save(r: RateRow) {
    const pct = Number(edit[r.termMonths])
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) return setRateErr('Enter a rate between 0 and 50 (percent a year)')
    setRateErr(null)
    setRate.mutate({ termMonths: r.termMonths, rateBps: Math.round(pct * 100) })
  }
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Fixed deposits</h1>
      <section aria-labelledby="cl-h" className="mb-10">
        <h2 id="cl-h" className="mb-3 text-xl font-semibold">Early closure requests</h2>
        {closures.isPending && <p className="text-muted">Loading…</p>}
        <Err e={closures.error} />
        {closures.data?.items.length === 0 && <p className="text-muted">No requests are waiting.</p>}
        <ul className="space-y-3">
          {closures.data?.items.map((c) => (
            <li key={c.id} className={card}>
              <div className="font-semibold">{c.reference} <span className="text-sm font-normal text-muted">{c.customerName} · principal {formatMinor(c.principalMinor)}{c.reason ? ` · “${c.reason}”` : ''}</span></div>
              <div className="text-sm">Estimated payout <b>{formatMinor(c.estimate.payoutMinor)}</b> (interest {formatMinor(c.estimate.interestMinor)}, penalty {formatMinor(c.estimate.penaltyMinor)})</div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button className={`${btn} bg-ok`} disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, decision: 'APPROVE' })}>Approve closure</button>
                <input aria-label="Reason" placeholder="Reason (required to reject)" className={`${input} min-w-56 flex-1`} value={reason[c.id] ?? ''} onChange={(e) => setReason({ ...reason, [c.id]: e.target.value })} />
                <button className={`${btn} bg-err`} disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, decision: 'REJECT' })}>Reject</button>
              </div>
            </li>
          ))}
        </ul>
        <Err e={decide.error} />
      </section>
      <section aria-labelledby="rt-h">
        <h2 id="rt-h" className="mb-3 text-xl font-semibold">Rate card</h2>
        {!can('settings.manage') && <p className="mb-2 text-sm text-muted">You can view rates. Changing them needs the settings permission.</p>}
        <div className="overflow-x-auto rounded-2xl bg-surface ring-1 ring-black/5">
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th scope="col" className="px-4 py-3">Term</th><th scope="col" className="px-4 py-3">Rate (% a year)</th><th scope="col" className="px-4 py-3">Minimum</th><th scope="col" className="px-4 py-3">Status</th><th scope="col" className="px-4 py-3" /></tr></thead>
            <tbody>
              {rates.data?.items.map((r) => (
                <tr key={r.termMonths} className="border-t border-black/5">
                  <td className="px-4 py-2">{r.termMonths} months</td>
                  <td className="px-4 py-2">{can('settings.manage')
                    ? <input aria-label={`Rate for ${r.termMonths} months`} className={`${input} w-24`} value={edit[r.termMonths] ?? (r.rateBps / 100).toFixed(2)} onChange={(e) => setEdit({ ...edit, [r.termMonths]: e.target.value })} />
                    : (r.rateBps / 100).toFixed(2)}</td>
                  <td className="px-4 py-2 tabular-nums">{formatMinor(r.minAmountMinor)}</td>
                  <td className="px-4 py-2">{r.active ? 'Offered' : 'Withdrawn'}</td>
                  <td className="px-4 py-2">{can('settings.manage') && (<span className="flex gap-2">
                    <button className={`${btn} bg-primary`} disabled={setRate.isPending} onClick={() => save(r)}>Save</button>
                    <button className={`${btn} bg-navy`} disabled={setRate.isPending} onClick={() => setRate.mutate({ termMonths: r.termMonths, rateBps: r.rateBps, active: !r.active })}>{r.active ? 'Withdraw' : 'Offer'}</button>
                  </span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rateErr && <p role="alert" className="mt-3 text-err">{rateErr}</p>}
        <Err e={setRate.error ?? rates.error} />
      </section>
    </div>
  )
}
