import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { btn, card, Err, input } from '../../components/ui'
import { api } from '../../services/api'

interface Past { at: string; kind: string; title: string; recipients: number }

/** Offers and bank notices, delivered to every active customer's notifications. Customers can switch offers off; notices are bank news. */
export function AnnouncementsPage() {
  const qc = useQueryClient()
  const past = useQuery({ queryKey: ['announcements'], queryFn: () => api<{ items: Past[] }>('/admin/announcements') })
  const [kind, setKind] = useState<'OFFER' | 'NOTICE'>('NOTICE')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sent, setSent] = useState<number | null>(null)
  const send = useMutation({
    mutationFn: () => api<{ recipients: number }>('/admin/announcements', { method: 'POST', body: JSON.stringify({ kind, title: title.trim(), body: body.trim() }) }),
    onSuccess: (r) => { setSent(r.recipients); setTitle(''); setBody(''); qc.invalidateQueries({ queryKey: ['announcements'] }) },
  })
  const ready = title.trim().length >= 3 && body.trim().length >= 3
  return (
    <section aria-labelledby="ann-h">
      <h1 id="ann-h" className="mb-2 text-2xl font-semibold">Announcements</h1>
      <p className="mb-4 text-sm text-muted">Sent to every active customer. This cannot be undone, so check the wording first.</p>
      <form className={`${card} max-w-xl space-y-3`} onSubmit={(e) => { e.preventDefault(); if (ready && window.confirm('Send this to every active customer?')) send.mutate() }}>
        <label className="block text-sm">Type
          <select className={`${input} mt-1 block w-full`} value={kind} onChange={(e) => setKind(e.target.value as 'OFFER' | 'NOTICE')}>
            <option value="NOTICE">Bank notice</option>
            <option value="OFFER">Offer</option>
          </select>
        </label>
        <label className="block text-sm">Title
          <input className={`${input} mt-1 block w-full`} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block text-sm">Message
          <textarea className={`${input} mt-1 block w-full`} rows={4} maxLength={400} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <Err e={send.error} />
        {sent !== null && <p role="status" className="text-sm">Sent to {sent} customers.</p>}
        <button className={`${btn} bg-navy`} disabled={!ready || send.isPending}>Send to all customers</button>
      </form>
      <h2 className="mb-2 mt-6 text-lg font-semibold">Recently sent</h2>
      {past.isPending && <p className="text-muted">Loading…</p>}
      <ul className="space-y-2">
        {past.data?.items.map((p) => (
          <li key={`${p.at}${p.title}`} className={card}><span className="font-medium">{p.title}</span> <span className="text-sm text-muted">· {p.kind === 'OFFER' ? 'Offer' : 'Bank notice'} · {p.recipients} customers · {new Date(p.at).toLocaleString()}</span></li>
        ))}
      </ul>
    </section>
  )
}
