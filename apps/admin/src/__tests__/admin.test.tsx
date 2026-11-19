import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../auth'
import LoginPage from '../features/auth/LoginPage'
import PaymentsPage from '../features/payments/PaymentsPage'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api, setTokens } from '../services/api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setTokens(null, null) })

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

describe('transaction monitoring', () => {
  const row = (over: object = {}) => ({
    id: '1', reference: 'ZX20261119ABCD2345', kind: 'INTERNAL_TRANSFER', status: 'POSTED', amountMinor: 250050, feeMinor: 0, currency: 'LKR',
    recipient: { name: 'Nuwan Silva', bank: 'Zentrix Bank', accountMasked: '*******9876' }, customerName: 'Amaya Perera', customerNumber: 'ZB90000001',
    createdAt: '2026-03-01T10:00:00Z', postedAt: '2026-03-01T10:00:05Z', failureCode: null, ...over,
  })
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PaymentsPage /></QueryClientProvider>)

  it('lists ledger-backed payments with formatted amounts and filters by status through the API', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return json(200, { items: url.includes('status=FAILED') ? [row({ id: '2', status: 'FAILED', failureCode: 'INSUFFICIENT_FUNDS' })] : [row(), row({ id: '3', kind: 'INTERBANK_TRANSFER', feeMinor: 2500 })] })
    }))
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findAllByText('LKR 2,500.50')).toHaveLength(2)
    expect(screen.getByText('LKR 25.00')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText(/status/i), 'FAILED')
    expect(await screen.findByText('INSUFFICIENT_FUNDS')).toBeInTheDocument()
    expect(urls.some((u) => u.endsWith('/admin/payments?status=FAILED'))).toBe(true)
  })

  it('shows the permission error instead of data when the API refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { code: 'forbidden', message: 'You do not have access to this resource' })))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not have access/i)
  })
})
