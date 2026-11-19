import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, AuthProvider, type AuthState } from '../auth'
import { CardsAdminPage, DepositsAdminPage, LoansAdminPage } from '../features/products/ProductAdminPages'
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
  const viewer: AuthState = { me: { id: 's', type: 'STAFF', username: 's', permissions: ['transactions.read'] }, login: async () => {}, logout: async () => {}, can: (p) => p === 'transactions.read' }
  const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuthContext.Provider value={viewer}><PaymentsPage /></AuthContext.Provider></QueryClientProvider>)

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

describe('product administration', () => {
  const staff = (id: string, perms: string[]): AuthState => ({ me: { id, type: 'STAFF', username: id, permissions: perms }, login: async () => {}, logout: async () => {}, can: (p) => perms.includes(p) })
  const mount = (ui: React.ReactElement, auth: AuthState) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuthContext.Provider value={auth}>{ui}</AuthContext.Provider></QueryClientProvider>)

  it('loan approvals: the maker cannot decide their own recommendation, another approver can', async () => {
    const calls: string[] = []
    const approval = { id: 'ap1', requestedBy: 'maker-1', requestedByName: 'Maker One', customerName: 'Amaya Perera', terms: { amountMinor: '25000000', termMonths: 6, rateBps: 1450, conditions: 'Salary slip on file' } }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/loan-approvals/ap1/decision')) return json(201, { status: 'APPROVED' })
      if (url.includes('/loan-approvals')) return json(200, { items: [approval] })
      return json(200, { items: [] })
    }))
    const maker = mount(<LoansAdminPage />, staff('maker-1', ['loans.review', 'loans.approve']))
    expect(await screen.findByText(/LKR 250,000.00/)).toBeInTheDocument()
    expect(screen.getByText(/another approver must decide it/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve & disburse/i })).toBeDisabled()
    maker.unmount()

    const user = userEvent.setup()
    mount(<LoansAdminPage />, staff('checker-2', ['loans.review', 'loans.approve']))
    const approve = await screen.findByRole('button', { name: /approve & disburse/i })
    expect(approve).toBeEnabled()
    await user.click(approve)
    await waitFor(() => expect(calls.some((c) => c === 'POST /api/v1/admin/loan-approvals/ap1/decision')).toBe(true))
  })

  it('credit card approval requires a staff-set limit before anything is sent', async () => {
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined })
      if (url.includes('/decision')) return json(201, { status: 'PREPARING' })
      return json(200, { items: [{ id: 'c1', kind: 'CREDIT', status: 'PENDING_APPROVAL', createdAt: '2026-03-01T00:00:00Z', customerName: 'Amaya Perera', customerNumber: 'ZB1', replacement: false, last4: null, application: { monthlyIncomeMinor: 25000000, employment: 'Engineer', requestedLimitMinor: 20000000 } }] })
    }))
    const user = userEvent.setup()
    mount(<CardsAdminPage />, staff('s1', ['cards.review']))
    await user.click(await screen.findByRole('button', { name: /^approve$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/credit limit/i)
    expect(calls.some((c) => c.url.includes('/decision'))).toBe(false)
    await user.type(screen.getByLabelText(/credit limit/i), '150000.00')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/decision'))).toBe(true))
    expect(JSON.parse(calls.find((c) => c.url.includes('/decision'))!.body!)).toMatchObject({ decision: 'APPROVE', creditLimitMinor: 15000000 })
  })

  it('rate card: editing needs the settings permission and sends basis points', async () => {
    const calls: { method: string; url: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body as string | undefined })
      if (url.includes('fixed-deposit-rates')) return init?.method === 'PUT' ? json(200, {}) : json(200, { items: [{ termMonths: 12, rateBps: 900, minAmountMinor: 1000000, active: true }] })
      return json(200, { items: [] })
    }))
    const view = mount(<DepositsAdminPage />, staff('viewer', ['deposits.manage']))
    expect(await screen.findByText('9.00')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull() // no settings permission: read-only
    view.unmount()

    const user = userEvent.setup()
    mount(<DepositsAdminPage />, staff('admin', ['deposits.manage', 'settings.manage']))
    const field = await screen.findByLabelText(/rate for 12 months/i)
    await user.clear(field)
    await user.type(field, '9.75')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ termMonths: 12, rateBps: 975 })
    await user.clear(field)
    await user.type(field, '99')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/between 0 and 50/i)
  })
})
