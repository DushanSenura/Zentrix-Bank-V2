import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Err, btn, input, td, th } from '../../components/ui'
import { api, apiText, saveTextFile } from '../../services/api'

const REPORTS = [
  { key: 'transactions-daily', label: 'Daily transactions' },
  { key: 'customer-growth', label: 'Customer & account growth' },
  { key: 'audit-activity', label: 'Audit activity' },
]

interface Report { title: string; columns: string[]; rows: Record<string, string | number>[] }

const label = (c: string) => {
  const money = c.endsWith('Minor')
  const words = (money ? c.slice(0, -5) : c).replace(/([A-Z])/g, ' $1').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1) + (money ? ' (LKR)' : '')
}
const cell = (c: string, v: string | number) => (c.endsWith('Minor') && typeof v === 'number' ? (v / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v))

export default function ReportsPage() {
  const [name, setName] = useState(REPORTS[0]!.key)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [exportErr, setExportErr] = useState<unknown>(null)
  const qs = () => { const p = new URLSearchParams(); if (from) p.set('from', new Date(from).toISOString()); if (to) p.set('to', new Date(`${to}T23:59:59`).toISOString()); return p.toString() }
  const q = useQuery({ queryKey: ['report', name, from, to], queryFn: () => api<Report>(`/admin/reports/${name}?${qs()}`) })

  async function exportCsv() {
    setExportErr(null)
    try { saveTextFile(`${name}.csv`, await apiText(`/admin/reports/${name}/export?${qs()}`)) } catch (e) { setExportErr(e) }
  }

  return (
    <section aria-labelledby="rp-h">
      <h1 id="rp-h" className="mb-4 text-2xl font-semibold">Reports</h1>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">Report<br /><select className={input} value={name} onChange={(e) => setName(e.target.value)}>{REPORTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
        <label className="text-sm">From<br /><input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">To<br /><input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="text-xs text-muted">Default: last 30 days (max 366).</span>
        <button className={`${btn} ml-auto bg-navy`} onClick={exportCsv}>Export CSV</button>
      </div>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error ?? exportErr} />
      {q.data && q.data.rows.length === 0 && <p className="text-muted">No data in this range.</p>}
      {q.data && q.data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-surface ring-1 ring-black/5">
          <table className="w-full text-left text-sm">
            <caption className="px-4 py-3 text-left font-semibold">{q.data.title}</caption>
            <thead className="text-muted"><tr>{q.data.columns.map((c) => <th key={c} scope="col" className={th}>{label(c)}</th>)}</tr></thead>
            <tbody>{q.data.rows.map((r, i) => <tr key={i} className="border-t border-black/5">{q.data.columns.map((c) => <td key={c} className={`${td} tabular-nums`}>{cell(c, r[c]!)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}
