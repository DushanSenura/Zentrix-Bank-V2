import { useEffect, useState } from 'react'

interface Demo { username: string; password: string; kind: 'STAFF' | 'CUSTOMER'; role: string; fullName: string; mfaCode?: string; mfaSecondsLeft?: number }

/**
 * Development-only helper: lists the fictional seeded staff accounts so they can be tried quickly. It renders nothing in a production
 * build (`import.meta.env.DEV` is false), and the API answers 404 outside APP_ENV=development, so a deployed portal never shows it.
 */
export default function DemoAccounts({ onPick }: { onPick: (username: string, password: string, code?: string) => void }) {
  const [accounts, setAccounts] = useState<Demo[] | null>(null)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/v1/dev/demo-accounts')
        if (!r.ok) { if (alive) setAccounts(null); return }
        const body = (await r.json()) as { accounts: Demo[] }
        if (alive) setAccounts(body.accounts.filter((a) => a.kind === 'STAFF'))
      } catch { if (alive) setAccounts(null) }
    }
    void load()
    const t = setInterval(load, 5000) // the authenticator code changes every 30 seconds
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!import.meta.env.DEV || !accounts || accounts.length === 0) return null
  return (
    <section aria-labelledby="demo-h" className="mt-4 w-full max-w-2xl rounded-2xl bg-surface p-6 text-sm ring-1 ring-black/5">
      <h2 id="demo-h" className="font-semibold">Demo staff accounts <span className="font-normal text-muted">(development only, fictional)</span></h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-muted"><tr><th scope="col" className="py-1 pr-3 font-medium">Role</th><th scope="col" className="py-1 pr-3 font-medium">Username</th><th scope="col" className="py-1 pr-3 font-medium">Password</th><th scope="col" className="py-1 pr-3 font-medium">Code now</th><th scope="col" className="py-1"><span className="sr-only">Use</span></th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.username} className="border-t border-black/5">
                <td className="py-1.5 pr-3">{a.role}</td>
                <td className="py-1.5 pr-3 font-mono">{a.username}</td>
                <td className="py-1.5 pr-3 font-mono">{a.password}</td>
                <td className="py-1.5 pr-3 font-mono">{a.mfaCode ?? '–'}</td>
                <td className="py-1.5"><button type="button" className="rounded-lg bg-primary px-2.5 py-1 text-white" onClick={() => onPick(a.username, a.password, a.mfaCode)} aria-label={`Fill sign-in with ${a.role}`}>Use</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
