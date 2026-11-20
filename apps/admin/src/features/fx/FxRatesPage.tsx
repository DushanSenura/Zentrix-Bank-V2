import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { btn, card, Err, input } from '../../components/ui'
import { api } from '../../services/api'

interface Rates { spreadBps: number; base: string; note: string; items: { currency: string; midRate: number; youPayPerUnit: number; youGetPerUnit: number; updatedAt: string | null }[] }

/** Staff set the mid rate per currency (LKR per one unit). Customers see mid plus the spread when buying and mid minus the spread when selling. */
export function FxRatesPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['fx-rates'], queryFn: () => api<Rates>('/admin/fx/rates') })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: (v: { currency: string; midRate: number }) => api(`/admin/fx/rates/${v.currency}`, { method: 'PUT', body: JSON.stringify({ midRate: v.midRate }) }),
    onSuccess: (_d, v) => { setDraft((d) => ({ ...d, [v.currency]: '' })); qc.invalidateQueries({ queryKey: ['fx-rates'] }) },
  })
  const d = q.data
  return (
    <section aria-labelledby="fx-h">
      <h1 id="fx-h" className="mb-2 text-2xl font-semibold">Exchange rates</h1>
      <p className="mb-4 text-sm text-muted">Simulated rates (LKR per one unit). A rate cannot change by more than 20% at once. The spread ({d ? `${(d.spreadBps / 100).toFixed(2)}%` : '…'}) is set under Settings.</p>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      <ul className="space-y-3">
        {d?.items.map((r) => {
          const v = draft[r.currency] ?? ''
          const num = Number(v)
          return (
            <li key={r.currency} className={`${card} flex flex-wrap items-end gap-4`}>
              <div className="min-w-24"><div className="text-lg font-semibold">{r.currency}</div><div className="text-xs text-muted">{r.updatedAt ? `Updated ${new Date(r.updatedAt).toLocaleString()}` : 'Default rate'}</div></div>
              <div><div className="text-xs text-muted">Mid</div><div className="font-mono">{r.midRate.toFixed(2)}</div></div>
              <div><div className="text-xs text-muted">Customers buy at</div><div className="font-mono">{r.youPayPerUnit.toFixed(2)}</div></div>
              <div><div className="text-xs text-muted">Customers sell at</div><div className="font-mono">{r.youGetPerUnit.toFixed(2)}</div></div>
              <label className="ml-auto text-sm">New mid rate
                <input className={`${input} mt-1 block w-32`} inputMode="decimal" value={v} onChange={(e) => setDraft({ ...draft, [r.currency]: e.target.value })} aria-label={`New mid rate for ${r.currency}`} />
              </label>
              <button className={`${btn} bg-navy`} disabled={save.isPending || !(num > 0)} onClick={() => save.mutate({ currency: r.currency, midRate: num })}>Save</button>
            </li>
          )
        })}
      </ul>
      <Err e={save.error} />
      <p className="mt-4 text-xs text-muted">{d?.note}</p>
    </section>
  )
}
