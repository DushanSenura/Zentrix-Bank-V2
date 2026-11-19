import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, setSessionLostHandler, setTokens, type Me } from './services/api'

interface AuthState {
  me: Me | null
  login: (identifier: string, password: string, mfaCode?: string) => Promise<void>
  logout: () => Promise<void>
  can: (permission: string) => boolean
}
const Ctx = createContext<AuthState | null>(null)
/** Exported so tests can supply a staff identity without a network login. */
export const AuthContext = Ctx
export type { AuthState }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  useEffect(() => { setSessionLostHandler(() => { setTokens(null, null); setMe(null) }) }, [])

  const login: AuthState['login'] = async (identifier, password, mfaCode) => {
    const t = await api<{ accessToken: string; refreshToken: string; userType: string }>(
      '/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password, mfaCode: mfaCode || undefined }) }, false)
    if (t.userType !== 'STAFF') {
      // A customer signed in on the staff portal: end that session immediately and refuse.
      setTokens(t.accessToken, t.refreshToken)
      try { await api('/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
      setTokens(null, null)
      throw new ApiError(403, 'not_staff', 'This portal is for bank staff only')
    }
    setTokens(t.accessToken, t.refreshToken)
    setMe(await api<Me>('/me'))
  }
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }) } catch { /* session may already be gone */ }
    setTokens(null, null); setMe(null)
  }
  const can = (p: string) => !!me?.permissions?.includes(p)
  return <Ctx.Provider value={{ me, login, logout, can }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('AuthProvider missing')
  return c
}
