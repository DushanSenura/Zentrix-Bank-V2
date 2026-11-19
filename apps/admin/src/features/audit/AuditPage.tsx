import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Err, btn, input, td, th } from '../../components/ui'
import { api, apiText, saveTextFile } from '../../services/api'

interface Entry { id: string; at: string; actorName: string | null; actorType: string; action: string; subjectType: string | null; subjectId: string | null; reasonCode: string | null; ip: string | null }

export default function AuditPage() {
  const [f, setF] = useState({ action: '', subjectType: '', from: '', to: '' })
  const [applied, setApplied] = useState(f)
  const [exportErr, setExportErr] = useState<unknown>(null)
  const params = (a: typeof f) => {
    const p = new URLSearchParams()
    if (a.action) p.set('action', a.action)
    if (a.subjectType) p.set('subjectType', a.subjectType)
    if (a.from) p.set('from', new Date(a.from).toISOString())
    if (a.to) p.set('to', new Date(`${a.to}T23:59:59`).toISOString())
    return p
  }
  const q = useInfiniteQuery({
    queryKey: ['audit', applied],
    initialPageParam: '',
    queryFn: ({ pageParam }) => { const p = params(applied); p.set('limit', '50'); if (pageParam) p.set('cursor', pageParam); return api<{ items: Entry[]; nextCursor: string | null }>(`/admin/audit?${p}`) },
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  })
  const rows = q.data?.pages.flatMap((p) => p.items) ?? []

  async function exportCsv() {
    setExportErr(null)
    try { saveTextFile('audit.csv', await apiText(`/admin/audit-export?${params(applied)}`)) } catch (e) { setExportErr(e) }
  }

  return (
    <section aria-labelledby="au-h">
      <h1 id="au-h" className="mb-4 text-2xl font-semibold">Audit log</h1>
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setApplied(f) }}>
        <label className="text-sm">Action contains<br /><input className={input} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} placeholder="e.g. loan." /></label>
        <label className="text-sm">Subject type<br /><input className={input} value={f.subjectType} onChange={(e) => setF({ ...f, subjectType: e.target.value })} placeholder="e.g. User" /></label>
        <label className="text-sm">From<br /><input type="date" className={input} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="text-sm">To<br /><input type="date" className={input} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <button className={`${btn} bg-primary`}>Apply</button>
        <button type="button" className={`${btn} ml-auto bg-navy`} onClick={exportCsv}>Export CSV</button>
      </form>
      <p className="mb-2 text-xs text-muted">Exports are limited to 5,000 rows, exclude detail fields, and are themselves recorded in this log.</p>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error ?? exportErr} />
      {!q.isPending && rows.length === 0 && <p className="text-muted">No entries match.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-surface ring-1 ring-black/5">
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr>{['When', 'Actor', 'Action', 'Subject', 'Reason', 'IP'].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-black/5">
                  <td className={`${td} whitespace-nowrap`}>{new Date(r.at).toLocaleString()}</td>
                  <td className={td}>{r.actorName ?? '—'}<div className="text-xs text-muted">{r.actorType.toLowerCase()}</div></td>
                  <td className={`${td} font-mono text-xs`}>{r.action}</td>
                  <td className={td}>{r.subjectType}<div className="font-mono text-xs text-muted">{r.subjectId?.slice(0, 13)}</div></td>
                  <td className={td}>{r.reasonCode}</td>
                  <td className={`${td} text-xs`}>{r.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && <button className={`${btn} mt-4 bg-primary`} disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
    </section>
  )
}
