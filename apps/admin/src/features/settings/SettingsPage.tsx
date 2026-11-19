import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Err, Pill, btn, card, input } from '../../components/ui'
import { formatMinor } from '../../lib/money'
import { api } from '../../services/api'

interface Setting { key: string; label: string; group: string; type: 'int' | 'bool' | 'string'; min?: number; max?: number; value: number | boolean | string; isDefault: boolean; help?: string }

export default function SettingsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<{ items: Setting[] }>('/admin/settings') })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [localErr, setLocalErr] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (v: { key: string; value: number | boolean | string }) => api(`/admin/settings/${v.key}`, { method: 'PUT', body: JSON.stringify({ value: v.value }) }),
    onSuccess: (_r, v) => { setDraft((d) => { const n = { ...d }; delete n[v.key]; return n }); qc.invalidateQueries({ queryKey: ['settings'] }) },
  })
  const groups = [...new Set(q.data?.items.map((s) => s.group))]
  const maintenance = q.data?.items.find((s) => s.key === 'maintenance.enabled')

  function commit(s: Setting) {
    const raw = draft[s.key]
    if (raw === undefined) return
    if (s.type === 'int') {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < (s.min ?? 0) || n > (s.max ?? Number.MAX_SAFE_INTEGER)) return setLocalErr(`${s.label}: enter a whole number between ${s.min ?? 0} and ${s.max}`)
      setLocalErr(null); save.mutate({ key: s.key, value: n })
    } else { setLocalErr(null); save.mutate({ key: s.key, value: raw }) }
  }

  return (
    <section aria-labelledby="se-h">
      <h1 id="se-h" className="mb-2 text-2xl font-semibold">Bank policy settings</h1>
      <p className="mb-4 text-sm text-muted">Changes take effect immediately and are recorded in the audit log with the old and new value.</p>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      {maintenance && (
        <div className={`${card} mb-6 ${maintenance.value === true ? 'ring-warn' : ''}`}>
          <div className="flex items-center gap-3">
            <div><h2 className="font-semibold">Maintenance mode</h2><p className="text-sm text-muted">While on, customers see a maintenance notice and cannot use the apps. Staff can still sign in.</p></div>
            <button role="switch" aria-checked={maintenance.value === true} aria-label="Maintenance mode" className={`${btn} ml-auto ${maintenance.value === true ? 'bg-warn' : 'bg-navy'}`} disabled={save.isPending} onClick={() => save.mutate({ key: 'maintenance.enabled', value: maintenance.value !== true })}>{maintenance.value === true ? 'Turn off' : 'Turn on'}</button>
          </div>
        </div>
      )}
      <div className="space-y-6">
        {groups.map((g) => (
          <div key={g} className={card}>
            <h2 className="mb-3 font-semibold">{g}</h2>
            <div className="space-y-4">
              {q.data!.items.filter((s) => s.group === g && s.key !== 'maintenance.enabled').map((s) => {
                const shown = draft[s.key] ?? String(s.value)
                return (
                  <div key={s.key} className="grid items-center gap-2 md:grid-cols-[18rem_1fr_auto]">
                    <label htmlFor={s.key} className="text-sm"><b>{s.label}</b>{s.isDefault && <> <Pill>default</Pill></>}{s.help && <div className="text-xs text-muted">{s.help}</div>}</label>
                    <div className="flex items-center gap-2">
                      <input id={s.key} className={`${input} w-64`} value={shown} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
                      {s.type === 'int' && /Minor$/.test(s.key) && Number.isInteger(Number(shown)) && <span className="text-xs text-muted">= {formatMinor(Number(shown))}</span>}
                    </div>
                    <button className={`${btn} bg-primary`} disabled={save.isPending || draft[s.key] === undefined || draft[s.key] === String(s.value)} onClick={() => commit(s)}>Save</button>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {localErr && <p role="alert" className="mt-3 text-err">{localErr}</p>}
      <Err e={save.error} />
    </section>
  )
}
