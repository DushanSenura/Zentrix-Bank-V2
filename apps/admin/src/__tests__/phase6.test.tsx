import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth'
import AuditPage from '../features/audit/AuditPage'
import { CustomerDetailPage, CustomersPage } from '../features/customers/CustomersPage'
import DashboardPage from '../features/dashboard/DashboardPage'
import OperationsPage from '../features/operations/OperationsPage'
import ReportsPage from '../features/reports/ReportsPage'
import SettingsPage from '../features/settings/SettingsPage'
import { RolesPage, StaffPage } from '../features/staff/StaffPages'
import AdminLayout from '../layouts/AdminLayout'
import { setTokens } from '../services/api'
import { Route, Routes } from 'react-router-dom'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const staff = (id: string, perms: string[]): AuthState => ({ me: { id, type: 'STAFF', username: id, fullName: id, permissions: perms }, login: async () => {}, logout: async () => {}, can: (p) => perms.includes(p) })
const mount = (ui: React.ReactElement, auth: AuthState, path = '/') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}><MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter></AuthContext.Provider>
    </QueryClientProvider>,
  )

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setTokens(null, null) })

describe('navigation', () => {
  it('shows only the sections the staff member has permission for', () => {
    mount(<Routes><Route element={<AdminLayout />}><Route index element={<p>home</p>} /></Route></Routes>, staff('aud', ['audit.read', 'reports.read', 'transactions.read']))
    const nav = within(screen.getByRole('navigation', { name: /^primary$/i }))
    for (const name of ['Dashboard', 'Audit log', 'Reports', 'Transactions']) expect(nav.getByRole('link', { name })).toBeInTheDocument()
    for (const name of ['Customers', 'Staff', 'Settings', 'Cards', 'Loans']) expect(nav.queryByRole('link', { name })).toBeNull()
  })
})

describe('dashboard', () => {
  it('renders real KPIs and the queues the caller may act on', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/admin/dashboard')) return json(200, {
        generatedAt: '2026-03-01T00:00:00Z', customers: { total: 1250, active: 1100, pendingKyc: 12, suspended: 3 },
        finance: { depositLiabilitiesMinor: 123456789, loanBalancesMinor: 5000000, today: { transfers: 42, volumeMinor: 9900000, feesMinor: 5000, failed: 2 }, series: [{ day: '2026-02-28', count: 3, volumeMinor: 100000 }] },
        pending: { kyc: 12, cards: 4, ledgerApprovals: 1 }, recentAudit: [{ id: '1', action: 'loan.disbursed', actorType: 'STAFF', subjectType: 'Loan', createdAt: '2026-03-01T00:00:00Z' }], securityAlerts24h: 2,
      })
      if (url.includes('/ledger/reconciliation')) return json(200, { ok: true, mismatches: [], pendingApprovals: 1, totalAdjustmentsMinor: 0, totals: [] })
      if (url.includes('/health')) return json(200, { status: 'ok', checks: { database: { status: 'up' }, redis: { status: 'up' } } })
      return json(404, {})
    }))
    mount(<DashboardPage />, staff('admin', ['customers.read', 'transactions.read', 'audit.read']))
    expect(await screen.findByText('1,250')).toBeInTheDocument()
    expect(screen.getByText('LKR 1,234,567.89')).toBeInTheDocument()
    expect(screen.getByText('LKR 50,000.00')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /12 KYC reviews/i })).toHaveAttribute('href', '/kyc')
    expect(screen.getByRole('link', { name: /4 Card requests/i })).toBeInTheDocument()
    expect(screen.queryByText(/Loan approvals/i)).toBeNull() // not in the response => not shown
    expect(screen.getByText('loan.disbursed')).toBeInTheDocument()
    expect(await screen.findByText('Balanced')).toBeInTheDocument()
  })

  it('surfaces a refused request instead of empty KPIs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { code: 'internal_error', message: 'Something went wrong on our side' })))
    mount(<DashboardPage />, staff('x', []))
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong/i)
  })
})

describe('customers', () => {
  it('searches with the server (debounced) and links to the 360 view', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return json(200, { items: [{ userId: 'u1', customerNumber: 'ZB90000001', fullName: 'Amaya Perera', email: 'a@t.test', status: 'ACTIVE', kycStatus: 'APPROVED', createdAt: '2026-01-01T00:00:00Z' }], nextCursor: null })
    }))
    const user = userEvent.setup()
    mount(<CustomersPage />, staff('s', ['customers.read']))
    expect(await screen.findByRole('link', { name: 'Amaya Perera' })).toHaveAttribute('href', '/customers/u1')
    await user.type(screen.getByLabelText(/search customers/i), 'amaya')
    await waitFor(() => expect(urls.some((u) => u.includes('q=amaya'))).toBe(true))
    expect(urls.filter((u) => u.includes('q=')).every((u) => u.includes('q=amaya'))).toBe(true) // typing did not fire a request per keystroke
  })

  const detail = (status: string) => ({
    userId: 'u1', customerNumber: 'ZB90000001', fullName: 'Amaya Perera', username: 'amaya', email: 'a@t.test', phone: null, status, createdAt: '2026-01-01T00:00:00Z',
    kyc: { status: 'APPROVED', note: null, dateOfBirth: '1990-05-05', nationalIdMasked: '********5678', address: { line1: '1 Test Rd', city: 'Colombo' } },
    security: { activeSessions: 2, failedLogins24h: 3, hasPin: true, lockedUntil: null, recentLogins: [] },
    accounts: [{ id: 'a1', accountNumber: '10000000001', product: 'Savings Account', status: 'ACTIVE', balanceMinor: 5000000, currency: 'LKR' }],
    cards: [], loans: [], fixedDeposits: [], recentPayments: [],
  })

  it('360 view masks the national ID and suspension needs a reason', async () => {
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined })
      if (init?.method === 'POST') return json(201, { status: 'SUSPENDED' })
      return json(200, detail('ACTIVE'))
    }))
    const user = userEvent.setup()
    mount(<Routes><Route path="/customers/:id" element={<CustomerDetailPage />} /></Routes>, staff('admin', ['customers.read', 'customers.suspend']), '/customers/u1')
    expect(await screen.findByText('********5678')).toBeInTheDocument()
    expect(screen.getByText('LKR 50,000.00')).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: /suspend customer/i })
    expect(btn).toBeDisabled()
    await user.type(screen.getByLabelText(/reason/i), 'Fraud review')
    await user.click(btn)
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/customers/u1/suspend'))).toBe(true))
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/suspend'))!.body!)).toEqual({ reason: 'Fraud review' })
  })

  it('without customers.suspend there is no suspend control at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, detail('ACTIVE'))))
    mount(<Routes><Route path="/customers/:id" element={<CustomerDetailPage />} /></Routes>, staff('csr', ['customers.read']), '/customers/u1')
    await screen.findByText('********5678')
    expect(screen.queryByRole('button', { name: /suspend/i })).toBeNull()
  })
})

describe('staff and roles', () => {
  const roles = { permissions: [{ key: 'reports.read', description: 'Reports' }, { key: 'staff.manage', description: 'Staff' }], items: [{ key: 'SUPER_ADMIN', name: 'Super Administrator', system: true, members: 1, permissions: ['reports.read', 'staff.manage'] }, { key: 'CARD_OFFICER', name: 'Card Officer', system: true, members: 3, permissions: ['reports.read'] }] }

  it('invitation: shows the dev setup token once and the server\'s escalation refusal', async () => {
    let refuse = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/admin/staff') && init?.method === 'POST') return refuse ? json(403, { code: 'privilege_escalation', message: 'You cannot grant the SUPER_ADMIN role: it includes access you do not have' }) : json(201, { userId: 'n1', username: 'newperson', setupToken: 'TOKEN-ABC-123' })
      if (url.endsWith('/admin/staff')) return json(200, { items: [] })
      if (url.endsWith('/admin/roles')) return json(200, roles)
      return json(404, {})
    }))
    const user = userEvent.setup()
    mount(<StaffPage />, staff('admin', ['staff.manage']))
    await user.type(await screen.findByLabelText('Full name'), 'New Person')
    await user.type(screen.getByLabelText('Username'), 'newperson')
    await user.type(screen.getByLabelText('Work email'), 'np@t.test')
    const send = screen.getByRole('button', { name: /send invitation/i })
    expect(send).toBeDisabled() // a role is required
    await user.click(await screen.findByRole('checkbox', { name: 'Card Officer' }))
    await user.click(send)
    expect(await screen.findByRole('status')).toHaveTextContent('TOKEN-ABC-123')

    refuse = true
    await user.type(screen.getByLabelText('Full name'), 'Sneaky')
    await user.type(screen.getByLabelText('Username'), 'sneaky')
    await user.type(screen.getByLabelText('Work email'), 'sn@t.test')
    await user.click(screen.getByRole('checkbox', { name: 'Super Administrator' }))
    await user.click(screen.getByRole('button', { name: /send invitation/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot grant the SUPER_ADMIN role/i)
  })

  it('the signed-in staff member cannot act on their own row', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/admin/roles') ? json(200, roles) : json(200, { items: [{ userId: 'me', fullName: 'Me Myself', username: 'me', email: 'm@t.test', employeeNo: 'E1', active: true, mfaEnrolled: true, roles: ['BANK_ADMIN'], lastLoginAt: null }, { userId: 'other', fullName: 'Other One', username: 'other', email: 'o@t.test', employeeNo: 'E2', active: true, mfaEnrolled: false, roles: ['CARD_OFFICER'], lastLoginAt: null }] }))))
    mount(<StaffPage />, staff('me', ['staff.manage']))
    expect(await screen.findByText('This is you')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /edit roles/i })).toHaveLength(1) // only for the other person
    expect(screen.getByText(/pending setup/i)).toBeInTheDocument()
  })

  it('role matrix is read-only without roles.manage and locks the Super Administrator column even with it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, roles)))
    const view = mount(<RolesPage />, staff('viewer', ['staff.manage']))
    const cb = await screen.findByRole('checkbox', { name: 'Card Officer staff.manage' })
    expect(cb).toBeDisabled()
    view.unmount()
    mount(<RolesPage />, staff('root', ['staff.manage', 'roles.manage']))
    expect(await screen.findByRole('checkbox', { name: 'Card Officer staff.manage' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Super Administrator staff.manage' })).toBeDisabled()
  })
})

describe('audit, reports and settings', () => {
  it('audit export downloads the CSV from the authenticated endpoint', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/audit-export')) return new Response('at,action\r\n2026,x\r\n', { status: 200, headers: { 'Content-Type': 'text/csv' } })
      return json(200, { items: [{ id: '1', at: '2026-03-01T00:00:00Z', actorName: 'Admin One', actorType: 'STAFF', action: 'staff.provisioned', subjectType: 'User', subjectId: 'abcdef0123456789', reasonCode: null, ip: '1.2.3.4' }], nextCursor: null })
    }))
    const created: Blob[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { created.push(b); return 'blob:x' }, revokeObjectURL: () => {} }))
    const user = userEvent.setup()
    mount(<AuditPage />, staff('aud', ['audit.read']))
    expect(await screen.findByText('staff.provisioned')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /export csv/i }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(urls.some((u) => u.includes('/admin/audit-export'))).toBe(true)
    expect(await created[0]!.text()).toContain('at,action')
  })

  it('reports render a table with money formatted from minor units', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { title: 'Daily transactions', columns: ['day', 'posted', 'failed', 'volumeMinor', 'feesMinor'], rows: [{ day: '2026-03-01', posted: 5, failed: 1, volumeMinor: 12345600, feesMinor: 5000 }] })))
    mount(<ReportsPage />, staff('ops', ['reports.read']))
    expect(await screen.findByText('123,456.00')).toBeInTheDocument()
    expect(screen.getByText('50.00')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /volume \(LKR\)/i })).toBeInTheDocument()
  })

  it('settings: validates before sending, sends the right type, and the maintenance switch is explicit', async () => {
    const puts: { url: string; body: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { puts.push({ url, body: init.body as string }); return json(200, {}) }
      return json(200, { items: [
        { key: 'fees.interbankMinor', label: 'Other-bank transfer fee', group: 'Fees', type: 'int', min: 0, max: 10000000, value: 2500, isDefault: true, help: 'Minor units' },
        { key: 'maintenance.enabled', label: 'Maintenance mode', group: 'System', type: 'bool', value: false, isDefault: true },
        { key: 'maintenance.message', label: 'Maintenance message', group: 'System', type: 'string', max: 200, value: 'Back soon', isDefault: true },
      ] })
    }))
    const user = userEvent.setup()
    mount(<SettingsPage />, staff('admin', ['settings.manage']))
    const fee = await screen.findByLabelText(/other-bank transfer fee/i)
    expect(screen.getByText('= LKR 25.00')).toBeInTheDocument()
    await user.clear(fee)
    await user.type(fee, '-5')
    await user.click(screen.getAllByRole('button', { name: /^save$/i })[0]!)
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number between 0/i)
    expect(puts).toHaveLength(0) // invalid input never reaches the server

    await user.clear(fee)
    await user.type(fee, '5000')
    await user.click(screen.getAllByRole('button', { name: /^save$/i })[0]!)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.url).toMatch(/settings\/fees\.interbankMinor$/)
    expect(JSON.parse(puts[0]!.body)).toEqual({ value: 5000 }) // a number, not a string

    await user.click(screen.getByRole('switch', { name: /maintenance mode/i }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(JSON.parse(puts[1]!.body)).toEqual({ value: true })
  })
})

describe('ledger operations', () => {
  it('the requester cannot approve their own request; another approver can; adjustment form validates first', async () => {
    const calls: { method: string; url: string }[] = []
    const mine = { id: 'ap1', kind: 'LEDGER_ADJUSTMENT', status: 'PENDING', createdAt: '2026-03-01T00:00:00Z', requestedBy: 'maker', requestedByName: 'Maker M', subjectId: 'a1', reason: 'Goodwill', reference: null, direction: 'CREDIT', amountMinor: 500000 }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url })
      if (url.includes('/reconciliation')) return json(200, { ok: true, mismatches: [], pendingApprovals: 1, totalAdjustmentsMinor: 0, totals: [{ currency: 'LKR', debit: '10', credit: '10' }] })
      if (url.includes('/decision')) return json(201, { status: 'APPROVED' })
      if (url.includes('/ledger/approvals')) return json(200, { items: [mine] })
      return json(201, {})
    }))
    const view = mount(<OperationsPage />, staff('maker', ['transactions.adjust', 'transactions.read']))
    expect(await screen.findByText(/Credit account · LKR 5,000.00/)).toBeInTheDocument()
    expect(screen.getByText(/another approver must decide it/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeDisabled()
    expect(await screen.findByText(/Ledger balanced/i)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /request adjustment/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/amount like/i)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    view.unmount()

    mount(<OperationsPage />, staff('checker', ['transactions.adjust', 'transactions.read']))
    const approve = await screen.findByRole('button', { name: /^approve$/i })
    expect(approve).toBeEnabled()
    await user.click(approve)
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/approvals/ap1/decision'))).toBe(true))
  })
})
