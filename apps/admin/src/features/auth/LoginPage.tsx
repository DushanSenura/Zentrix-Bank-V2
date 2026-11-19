import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../auth'
import { ApiError } from '../../services/api'

export default function LoginPage() {
  const { me, login } = useAuth()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needMfa, setNeedMfa] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (me) return <Navigate to="/" replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try { await login(identifier, password, needMfa ? code : undefined) }
    catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') setNeedMfa(true)
      else setError(err instanceof ApiError ? err.message : 'Cannot reach the server')
    } finally { setBusy(false) }
  }
  const field = 'mt-1 w-full rounded-lg border border-black/15 bg-surface px-3 py-2 outline-none focus:ring-2 focus:ring-primary'
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-black/5">
        <h1 className="text-xl font-semibold">Staff sign-in</h1>
        <label className="block text-sm">Username or email
          <input className={field} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required disabled={needMfa} />
        </label>
        <label className="block text-sm">Password
          <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required disabled={needMfa} />
        </label>
        {needMfa && (
          <label className="block text-sm">Authenticator code
            <input className={field} inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus required />
          </label>
        )}
        {error && <p role="alert" className="text-sm text-err">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-primary px-4 py-2 font-medium text-white disabled:opacity-60">{busy ? 'Signing in…' : needMfa ? 'Verify' : 'Continue'}</button>
      </form>
    </main>
  )
}
