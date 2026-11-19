import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth'
import { btn, card, Err, input, Pill } from '../../components/ui'
import { formatMinor } from '../../lib/money'
import { api } from '../../services/api'

const post = (path: string, body: unknown = {}, method = 'POST') => api(path, { method, body: JSON.stringify(body) })
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '')

// ═════════════════════════ disputes ═════════════════════════
interface DisputeItem {
  id: string; reference: string; reasonCode: string; description: string; status: string; customerName?: string; customerNumber?: string; createdAt: string
  payment: { reference: string; amountMinor: number; recipient: string | null } | null
}

export function DisputesPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [status, setStatus] = useState('OPEN')
  const [resolution, setResolution] = useState<Record<string, string>>({})
  const [reversal, setReversal] = useState<Record<string, boolean>>({})
  const q = useQuery({ queryKey: ['admin-disputes', status], queryFn: () => api<{ items: DisputeItem[] }>(`/admin/disputes?status=${status}`) })
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-disputes'] })
  const review = useMutation({ mutationFn: (id: string) => post(`/admin/disputes/${id}/review`), onSuccess: refresh })
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'ACCEPT' | 'REJECT' }) => post(`/admin/disputes/${v.id}/decision`, { decision: v.decision, resolution: resolution[v.id] ?? '', requestReversal: v.decision === 'ACCEPT' && reversal[v.id] ? true : undefined }),
    onSuccess: refresh,
  })

  return (
    <section aria-labelledby="disp-h">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 id="disp-h" className="text-2xl font-semibold">Payment problem reports</h1>
        <label className="ml-auto text-sm">Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
            {['OPEN', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      {q.data?.items.length === 0 && <p className="text-muted">Nothing here.</p>}
      <ul className="space-y-3">
        {q.data?.items.map((d) => (
          <li key={d.id} className={card}>
            <div className="font-semibold">{d.reference} <Pill>{d.status.replace('_', ' ').toLowerCase()}</Pill> <span className="text-sm font-normal text-muted">{d.customerName} · {d.customerNumber}</span></div>
            <div className="text-sm text-muted">{d.reasonCode.replaceAll('_', ' ').toLowerCase()} · reported {when(d.createdAt)}</div>
            {d.payment && <div className="mt-1 text-sm">Payment {d.payment.reference}: {formatMinor(d.payment.amountMinor)}{d.payment.recipient ? ` to ${d.payment.recipient}` : ''}</div>}
            <p className="mt-2 text-sm">{d.description}</p>
            {(d.status === 'OPEN' || d.status === 'UNDER_REVIEW') && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {d.status === 'OPEN' && <button className={`${btn} bg-navy`} disabled={review.isPending} onClick={() => review.mutate(d.id)}>Start review</button>}
                <input aria-label={`Resolution for ${d.reference}`} placeholder="Resolution shown to the customer" className={`${input} min-w-64 flex-1`} value={resolution[d.id] ?? ''} onChange={(e) => setResolution({ ...resolution, [d.id]: e.target.value })} />
                {can('transactions.adjust') && (
                  <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={!!reversal[d.id]} onChange={(e) => setReversal({ ...reversal, [d.id]: e.target.checked })} /> Request reversal (needs a second approver)</label>
                )}
                <button className={`${btn} bg-ok`} disabled={decide.isPending || (resolution[d.id] ?? '').trim().length < 5} onClick={() => decide.mutate({ id: d.id, decision: 'ACCEPT' })}>Accept</button>
                <button className={`${btn} bg-err`} disabled={decide.isPending || (resolution[d.id] ?? '').trim().length < 5} onClick={() => decide.mutate({ id: d.id, decision: 'REJECT' })}>Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Err e={review.error ?? decide.error} />
    </section>
  )
}

// ═════════════════════════ tickets ═════════════════════════
interface TicketItem { id: string; reference: string; subject: string; category: string; status: string; customerName?: string; customerNumber?: string; updatedAt: string; assignedToId?: string | null }
interface TicketDetail extends TicketItem {
  customer: { name?: string; customerNumber?: string }
  messages: { id: string; from: string; authorName?: string; body: string; internal: boolean; at: string }[]
  attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[]
}

export function TicketsPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('OPEN')
  const [mine, setMine] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['admin-tickets', status, mine], queryFn: () => api<{ items: TicketItem[] }>(`/admin/tickets?status=${status}${mine ? '&mine=true' : ''}`) })
  return (
    <section aria-labelledby="tk-h">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 id="tk-h" className="text-2xl font-semibold">Support requests</h1>
        <label className="ml-auto flex items-center gap-1 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me</label>
        <label className="text-sm">Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
            {['OPEN', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      {q.data?.items.length === 0 && <p className="text-muted">No requests.</p>}
      <ul className="space-y-2">
        {q.data?.items.map((t) => (
          <li key={t.id} className={card}>
            <button className="w-full text-left" aria-expanded={openId === t.id} onClick={() => setOpenId(openId === t.id ? null : t.id)}>
              <span className="font-semibold">{t.subject}</span> <span className="text-sm text-muted">{t.reference} · {t.category.toLowerCase()} · {t.customerName} · updated {when(t.updatedAt)}</span>
            </button>
            {openId === t.id && <TicketThread id={t.id} onChanged={() => qc.invalidateQueries({ queryKey: ['admin-tickets'] })} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

function TicketThread({ id, onChanged }: { id: string; onChanged: () => void }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const t = useQuery({ queryKey: ['admin-ticket', id], queryFn: () => api<TicketDetail>(`/admin/tickets/${id}`) })
  const done = () => { qc.invalidateQueries({ queryKey: ['admin-ticket', id] }); onChanged() }
  const reply = useMutation({ mutationFn: () => post(`/admin/tickets/${id}/messages`, { body, internal }), onSuccess: () => { setBody(''); done() } })
  const assign = useMutation({ mutationFn: () => post(`/admin/tickets/${id}/assign`), onSuccess: done })
  const setStatus = useMutation({ mutationFn: (s: string) => post(`/admin/tickets/${id}/status`, { status: s }, 'PUT'), onSuccess: done })
  if (t.isPending) return <p className="mt-3 text-muted">Loading…</p>
  if (t.error) return <Err e={t.error} />
  const d = t.data!
  return (
    <div className="mt-3 space-y-3">
      <ol className="space-y-2" aria-label="Conversation">
        {d.messages.map((m) => (
          <li key={m.id} className={`rounded-lg p-3 text-sm ${m.internal ? 'bg-warn/15 ring-1 ring-warn/40' : m.from === 'STAFF' ? 'bg-navy/10' : 'bg-black/5'}`}>
            <div className="text-xs text-muted">{m.internal ? 'Internal note (customer cannot see this) · ' : ''}{m.authorName ?? m.from} · {when(m.at)}</div>
            <div className="whitespace-pre-wrap">{m.body}</div>
          </li>
        ))}
      </ol>
      {d.attachments.length > 0 && <p className="text-sm text-muted">Attachments: {d.attachments.map((a) => a.fileName).join(', ')}</p>}
      {d.status !== 'CLOSED' && (
        <div className="space-y-2">
          <textarea aria-label="Reply" className={`${input} w-full`} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note</label>
            <button className={`${btn} bg-navy`} disabled={reply.isPending || body.trim().length < 1} onClick={() => reply.mutate()}>{internal ? 'Add note' : 'Send reply'}</button>
            <button className={`${btn} bg-navy/80`} disabled={assign.isPending} onClick={() => assign.mutate()}>Assign to me</button>
            <button className={`${btn} bg-ok`} disabled={setStatus.isPending} onClick={() => setStatus.mutate('RESOLVED')}>Resolve</button>
            <button className={`${btn} bg-err`} disabled={setStatus.isPending} onClick={() => setStatus.mutate('CLOSED')}>Close</button>
          </div>
        </div>
      )}
      <Err e={reply.error ?? assign.error ?? setStatus.error} />
    </div>
  )
}

// ═════════════════════════ branches & appointments ═════════════════════════
interface BranchItem { id: string; code: string; name: string; city: string; address: string; type: string; phone?: string | null; hours?: string | null; active?: boolean }
interface ApptItem { id: string; status: string; purpose: string; preferredAt: string; confirmedFor: string | null; branch?: string; customerName?: string; customerNumber?: string }

export function BranchesPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const branches = useQuery({ queryKey: ['admin-branches'], queryFn: () => api<{ items: BranchItem[] }>('/admin/branches'), enabled: can('branches.manage') })
  const [form, setForm] = useState({ code: '', name: '', city: '', address: '', type: 'BRANCH', phone: '', hours: '' })
  const create = useMutation({
    mutationFn: () => post('/admin/branches', { ...form, phone: form.phone || undefined, hours: form.hours || undefined }),
    onSuccess: () => { setForm({ code: '', name: '', city: '', address: '', type: 'BRANCH', phone: '', hours: '' }); qc.invalidateQueries({ queryKey: ['admin-branches'] }) },
  })
  const deactivate = useMutation({ mutationFn: (id: string) => api(`/admin/branches/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-branches'] }) })

  const appts = useQuery({ queryKey: ['admin-appts'], queryFn: () => api<{ items: ApptItem[] }>('/admin/appointments?status=REQUESTED'), enabled: can('support.manage') })
  const [at, setAt] = useState<Record<string, string>>({})
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'CONFIRM' | 'CANCEL'; confirmedFor?: string }) => post(`/admin/appointments/${v.id}/decision`, { decision: v.decision, confirmedFor: v.confirmedFor, note: v.decision === 'CANCEL' ? 'Cancelled by the branch' : undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-appts'] }),
  })
  const f = (k: keyof typeof form, label: string, extra = '') => (
    <label className="text-sm">{label}<input className={`${input} mt-1 block ${extra}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
  )

  return (
    <section aria-labelledby="br-h" className="space-y-8">
      <h1 id="br-h" className="text-2xl font-semibold">Branches and appointments</h1>

      {can('support.manage') && (
        <div>
          <h2 className="mb-2 text-lg font-semibold">Appointment requests</h2>
          {appts.data?.items.length === 0 && <p className="text-muted">No appointments waiting.</p>}
          <ul className="space-y-2">
            {appts.data?.items.map((a) => (
              <li key={a.id} className={card}>
                <div className="font-semibold">{a.branch} <span className="text-sm font-normal text-muted">{a.customerName} · {a.customerNumber}</span></div>
                <div className="text-sm">{a.purpose} · wants {when(a.preferredAt)}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input type="datetime-local" aria-label={`Confirm time for ${a.customerName}`} className={input} value={at[a.id] ?? ''} onChange={(e) => setAt({ ...at, [a.id]: e.target.value })} />
                  <button className={`${btn} bg-ok`} disabled={decide.isPending || !at[a.id]} onClick={() => decide.mutate({ id: a.id, decision: 'CONFIRM', confirmedFor: new Date(at[a.id]!).toISOString() })}>Confirm</button>
                  <button className={`${btn} bg-err`} disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: 'CANCEL' })}>Decline</button>
                </div>
              </li>
            ))}
          </ul>
          <Err e={appts.error ?? decide.error} />
        </div>
      )}

      {can('branches.manage') && (
        <div>
          <h2 className="mb-2 text-lg font-semibold">Locations</h2>
          <form className={`${card} mb-4 flex flex-wrap items-end gap-3`} onSubmit={(e) => { e.preventDefault(); create.mutate() }} aria-label="Add a location">
            {f('code', 'Code (e.g. KDY-01)', 'w-32')}{f('name', 'Name')}{f('city', 'City')}{f('address', 'Address', 'w-56')}
            <label className="text-sm">Type<select className={`${input} mt-1 block`} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="BRANCH">Branch</option><option value="ATM">ATM</option></select></label>
            {f('phone', 'Phone', 'w-36')}{f('hours', 'Hours', 'w-40')}
            <button className={`${btn} bg-navy`} disabled={create.isPending}>Add location</button>
          </form>
          <Err e={create.error ?? deactivate.error} />
          <ul className="space-y-2">
            {branches.data?.items.map((b) => (
              <li key={b.id} className={`${card} flex flex-wrap items-center gap-3`}>
                <span className="font-semibold">{b.name}</span> <span className="text-sm text-muted">{b.code} · {b.type.toLowerCase()} · {b.city}, {b.address}</span>
                {b.active === false ? <Pill tone="muted">inactive</Pill> : <button className={`${btn} ml-auto bg-err`} disabled={deactivate.isPending} onClick={() => deactivate.mutate(b.id)}>Deactivate</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
