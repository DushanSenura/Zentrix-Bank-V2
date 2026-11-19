import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../auth'
import LoginPage from '../features/auth/LoginPage'
import { api, setTokens } from '../services/api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals(); setTokens(null, null) })

describe('staff login', () => {
  it('asks for the authenticator code only after the server requires it, then signs in', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/auth/login')) {
        const b = JSON.parse(String(init?.body))
        return b.mfaCode ? json(200, { accessToken: 'a', refreshToken: 'r', userType: 'STAFF' }) : json(401, { code: 'mfa_required', message: 'Enter your authenticator code' })
      }
      if (url.endsWith('/me')) return json(200, { id: '1', type: 'STAFF', username: 'admin', fullName: 'Admin', permissions: ['kyc.review'] })
      return json(404, {})
    }))
    const user = userEvent.setup()
    render(<MemoryRouter><AuthProvider><LoginPage /></AuthProvider></MemoryRouter>)
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull()
    await user.type(screen.getByLabelText(/username/i), 'admin')
    await user.type(screen.getByLabelText(/^password/i), 'pw')
    await user.click(screen.getByRole('button', { name: /continue/i }))
    const code = await screen.findByLabelText(/authenticator code/i)
    await user.type(code, '123456')
    await user.click(screen.getByRole('button', { name: /verify/i }))
    await waitFor(() => expect(calls.some((c) => c.endsWith('/me'))).toBe(true))
  })

  it('refuses a customer account and revokes that session', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/auth/login')) return json(200, { accessToken: 'a', refreshToken: 'r', userType: 'CUSTOMER' })
      return new Response(null, { status: 204 })
    }))
    const user = userEvent.setup()
    render(<MemoryRouter><AuthProvider><LoginPage /></AuthProvider></MemoryRouter>)
    await user.type(screen.getByLabelText(/username/i), 'cust')
    await user.type(screen.getByLabelText(/^password/i), 'pw')
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/staff only/i)
    expect(calls.some((c) => c.includes('/auth/logout'))).toBe(true)
  })
})

describe('api client', () => {
  it('refreshes once on 401 and replays the request with the rotated token', async () => {
    setTokens('old', 'refresh1')
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('Authorization')
      seen.push(`${url} ${auth}`)
      if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'new', refreshToken: 'refresh2' })
      return auth === 'Bearer new' ? json(200, { ok: true }) : json(401, { code: 'session_expired', message: 'x' })
    }))
    expect(await api<{ ok: boolean }>('/me')).toEqual({ ok: true })
    expect(seen).toEqual(['/api/v1/me Bearer old', '/api/v1/auth/refresh null', '/api/v1/me Bearer new'])
  })
})
