import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth'
import { Err, Pill, btn, card, input, td, th } from '../../components/ui'
import { api } from '../../services/api'

interface StaffRow { userId: string; fullName?: string; username: string; email: string; employeeNo?: string; active: boolean; mfaEnrolled: boolean; roles: string[]; lastLoginAt: string | null }
interface RolesView { permissions: { key: string; description: string }[]; items: { key: string; name: string; system: boolean; members: number; permissions: string[] }[] }

export function StaffPage() {
  const { me } = useAuth()
  const qc = useQueryClient()
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api<{ items: StaffRow[] }>('/admin/staff') })
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RolesView>('/admin/roles') })
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff'] })

  const [form, setForm] = useState({ fullName: '', username: '', email: '' })
  const [picked, setPicked] = useState<string[]>([])
  const [invite, setInvite] = useState<{ username: string; setupToken?: string } | null>(null)
  const create = useMutation({
    mutationFn: () => api<{ userId: string; username: string; setupToken?: string }>('/admin/staff', { method: 'POST', body: JSON.stringify({ ...form, roleKeys: picked }) }),
    onSuccess: (r) => { setInvite(r); setForm({ fullName: '', username: '', email: '' }); setPicked([]); refresh() },
  })

  const [editing, setEditing] = useState<{ id: string; roles: string[] } | null>(null)
  const [reason, setReason] = useState<Record<string, string>>({})
  const setRoles = useMutation({ mutationFn: (v: { id: string; roleKeys: string[] }) => api(`/admin/staff/${v.id}/roles`, { method: 'PUT', body: JSON.stringify({ roleKeys: v.roleKeys }) }), onSuccess: () => { setEditing(null); refresh() } })
  const toggle = useMutation({ mutationFn: (v: { id: string; active: boolean }) => api(`/admin/staff/${v.id}/${v.active ? 'activate' : 'deactivate'}`, { method: 'POST', body: JSON.stringify({ reason: reason[v.id] ?? '' }) }), onSuccess: refresh })
  const revoke = useMutation({ mutationFn: (id: string) => api(`/admin/staff/${id}/revoke-sessions`, { method: 'POST' }), onSuccess: refresh })

  const flip = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k])
  const roleChoices = roles.data?.items ?? []

  return (
    <section aria-labelledby="st-h">
      <h1 id="st-h" className="mb-4 text-2xl font-semibold">Staff</h1>

      <form className={`${card} mb-6`} onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
        <h2 className="mb-3 font-semibold">Invite a staff member</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <input aria-label="Full name" placeholder="Full name" className={input} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
          <input aria-label="Username" placeholder="Username" className={input} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
          <input aria-label="Work email" type="email" placeholder="Work email" className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </div>
        <fieldset className="mt-3"><legend className="mb-1 text-sm text-muted">Roles (you can only grant access you hold yourself)</legend>
          <div className="flex flex-wrap gap-3">
            {roleChoices.map((r) => <label key={r.key} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={picked.includes(r.key)} onChange={() => setPicked(flip(picked, r.key))} />{r.name}</label>)}
          </div>
        </fieldset>
        <button className={`${btn} mt-3 bg-primary`} disabled={create.isPending || picked.length === 0}>Send invitation</button>
        <Err e={create.error} />
        {invite && (
          <div role="status" className="mt-3 rounded-lg bg-ok/10 p-3 text-sm">
            Invitation created for <b>{invite.username}</b>.
            {invite.setupToken ? <> Development setup token (shown once): <code className="break-all font-mono text-xs">{invite.setupToken}</code></> : ' The invitation will be delivered to their work email.'}
          </div>
        )}
      </form>

      {staff.isPending && <p className="text-muted">Loading…</p>}
      <Err e={staff.error} />
      <div className="overflow-x-auto rounded-2xl bg-surface ring-1 ring-black/5">
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr>{['Name', 'Username', 'Roles', 'MFA', 'Status', 'Last sign-in', 'Actions'].map((h) => <th key={h} scope="col" className={th}>{h === 'Actions' ? <span className="sr-only">{h}</span> : h}</th>)}</tr></thead>
          <tbody>
            {staff.data?.items.map((s) => (
              <tr key={s.userId} className="border-t border-black/5 align-top">
                <td className={td}>{s.fullName}<div className="text-xs text-muted">{s.email}</div></td>
                <td className={`${td} font-mono text-xs`}>{s.username}</td>
                <td className={td}>
                  {editing?.id === s.userId ? (
                    <div className="flex flex-col gap-1">
                      {roleChoices.map((r) => <label key={r.key} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={editing.roles.includes(r.key)} onChange={() => setEditing({ id: s.userId, roles: flip(editing.roles, r.key) })} />{r.name}</label>)}
                      <span className="flex gap-2"><button className={`${btn} bg-primary`} disabled={setRoles.isPending || editing.roles.length === 0} onClick={() => setRoles.mutate({ id: s.userId, roleKeys: editing.roles })}>Save roles</button><button className={`${btn} bg-navy`} onClick={() => setEditing(null)}>Cancel</button></span>
                    </div>
                  ) : s.roles.map((r) => <Pill key={r}>{r.replaceAll('_', ' ').toLowerCase()}</Pill>)}
                </td>
                <td className={td}>{s.mfaEnrolled ? <Pill tone="ok">enrolled</Pill> : <Pill tone="warn">pending setup</Pill>}</td>
                <td className={td}>{s.active ? <Pill tone="ok">active</Pill> : <Pill tone="err">inactive</Pill>}</td>
                <td className={`${td} whitespace-nowrap`}>{s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : 'never'}</td>
                <td className={td}>
                  {s.userId !== me?.id && (
                    <div className="flex flex-col gap-1">
                      <span className="flex gap-1">
                        <button className={`${btn} bg-navy`} onClick={() => setEditing({ id: s.userId, roles: s.roles })}>Edit roles</button>
                        <button className={`${btn} bg-navy`} disabled={revoke.isPending} onClick={() => revoke.mutate(s.userId)}>Sign out</button>
                      </span>
                      <span className="flex gap-1">
                        <input aria-label={`Reason for ${s.username}`} placeholder="Reason" className={`${input} w-28`} value={reason[s.userId] ?? ''} onChange={(e) => setReason({ ...reason, [s.userId]: e.target.value })} />
                        <button className={`${btn} ${s.active ? 'bg-err' : 'bg-ok'}`} disabled={toggle.isPending || (reason[s.userId] ?? '').trim().length < 3} onClick={() => toggle.mutate({ id: s.userId, active: !s.active })}>{s.active ? 'Deactivate' : 'Activate'}</button>
                      </span>
                    </div>
                  )}
                  {s.userId === me?.id && <span className="text-xs text-muted">This is you</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Err e={setRoles.error ?? toggle.error ?? revoke.error} />
    </section>
  )
}

export function RolesPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api<RolesView>('/admin/roles') })
  const [draft, setDraft] = useState<Record<string, string[]>>({})
  const save = useMutation({
    mutationFn: (key: string) => api(`/admin/roles/${key}/permissions`, { method: 'PUT', body: JSON.stringify({ permissionKeys: draft[key] }) }),
    onSuccess: (_r, key) => { setDraft((d) => { const n = { ...d }; delete n[key]; return n }); qc.invalidateQueries({ queryKey: ['roles'] }) },
  })
  const editable = can('roles.manage')
  const current = (key: string, base: string[]) => draft[key] ?? base
  return (
    <section aria-labelledby="ro-h">
      <h1 id="ro-h" className="mb-2 text-2xl font-semibold">Roles & permissions</h1>
      <p className="mb-4 text-sm text-muted">{editable ? 'You can grant a permission only if you hold it yourself. The Super Administrator role cannot be edited. Changes apply to the next request each affected user makes.' : 'View only. Editing roles needs the roles permission.'}</p>
      {q.isPending && <p className="text-muted">Loading…</p>}
      <Err e={q.error} />
      {q.data && (
        <div className="overflow-x-auto rounded-2xl bg-surface ring-1 ring-black/5">
          <table className="w-full text-left text-xs">
            <thead className="text-muted"><tr><th scope="col" className={th}>Permission</th>{q.data.items.map((r) => <th key={r.key} scope="col" className="px-2 py-3 text-center font-medium">{r.name}<div className="font-normal">{r.members} member(s)</div></th>)}</tr></thead>
            <tbody>
              {q.data.permissions.map((p) => (
                <tr key={p.key} className="border-t border-black/5">
                  <th scope="row" className="px-4 py-2 text-left font-normal"><div className="font-mono">{p.key}</div><div className="text-muted">{p.description}</div></th>
                  {q.data.items.map((r) => {
                    const on = current(r.key, r.permissions).includes(p.key)
                    const locked = r.key === 'SUPER_ADMIN' || !editable
                    return <td key={r.key} className="px-2 py-2 text-center"><input type="checkbox" aria-label={`${r.name} ${p.key}`} checked={on} disabled={locked} onChange={() => setDraft({ ...draft, [r.key]: on ? current(r.key, r.permissions).filter((x) => x !== p.key) : [...current(r.key, r.permissions), p.key] })} /></td>
                  })}
                </tr>
              ))}
              {editable && (
                <tr className="border-t border-black/5"><td className="px-4 py-3 text-muted">Save changes</td>{q.data.items.map((r) => <td key={r.key} className="px-2 py-3 text-center">{draft[r.key] && <button className={`${btn} bg-primary`} disabled={save.isPending} onClick={() => save.mutate(r.key)}>Save</button>}</td>)}</tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Err e={save.error} />
    </section>
  )
}
