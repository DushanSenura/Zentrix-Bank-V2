import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth'
import { RiskPage, SystemHealthPage } from '../features/risk/RiskPage'
import AdminLayout from '../layouts/AdminLayout'
import { setTokens } from '../services/api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const staff = (perms: string[]): AuthState => ({ me: { id: 's1', type: 'STAFF', username: 's1', fullName: 'Officer', permissions: perms }, login: async () => {}, logout: async () => {}, can: (p) => perms.includes(p) })
const mount = (ui: React.ReactElement, auth: AuthState) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}><MemoryRouter>{ui}</MemoryRouter></AuthContext.Provider>
    </QueryClientProvider>,
  )

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setTokens(null, null) })

const alert = { id: 'r1', ruleCode: 'HIGH_VALUE', severity: 'HIGH', summary: 'High-value payment of LKR 500,000.00', details: { amountMinor: 50000000, thresholdMinor: 10000000 }, status: 'OPEN', customerName: 'Nimal Perera', customerNumber: 'C001', resolutionNote: null, createdAt: new Date().toISOString() }

describe('risk alerts', () => {
  it('explains each alert, offers only review actions (no block or reverse), and requires a written note', async () => {
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined })
      return init?.method === 'POST' ? json(201, { id: 'r1', status: 'CLEARED' }) : json(200, { items: [alert] })
    }))
    mount(<RiskPage />, staff(['risk.review']))
    expect(await screen.findByText('High-value payment')).toBeInTheDocument()
    expect(screen.getByText(/not a certified compliance control/i)).toBeInTheDocument()
    expect(screen.getByText('thresholdMinor')).toBeInTheDocument() // the numbers behind the hit are shown
    expect(screen.queryByRole('button', { name: /block|reverse|freeze|suspend/i })).toBeNull()

    const clear = screen.getByRole('button', { name: 'Clear' })
    expect(clear).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Decision note/), 'Confirmed with the customer')
    expect(clear).toBeEnabled()
    await userEvent.click(clear)
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/risk/alerts/r1/resolve'))).toBe(true))
    expect(JSON.parse(calls.find((c) => c.url.includes('/resolve'))!.body!)).toEqual({ status: 'CLEARED', note: 'Confirmed with the customer' })
  })

  it('shows API refusals', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => (init?.method === 'POST' ? json(409, { code: 'already_resolved', message: 'This alert was already resolved' }) : json(200, { items: [alert] }))))
    mount(<RiskPage />, staff(['risk.review']))
    await screen.findByText('High-value payment')
    await userEvent.type(screen.getByLabelText(/Decision note/), 'Looks fine to me')
    await userEvent.click(screen.getByRole('button', { name: 'Escalate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already resolved')
  })
})

describe('system health', () => {
  it('shows real numbers and warnings from the API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {
      status: 'ATTENTION', warnings: ['Notifications are 20 minutes behind. Is the worker running?'], checkedAt: new Date().toISOString(),
      outbox: { pending: 7, oldestPendingSeconds: 1200, failing: 0 }, notificationsLast24h: 42, scheduledPaymentsOverdue: 0, unfinishedPaymentsOverAnHour: 0,
      queues: { openTickets: 3, openDisputes: 2 }, openRiskAlertsBySeverity: { HIGH: 1 },
    })))
    mount(<SystemHealthPage />, staff(['reports.read']))
    expect(await screen.findByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('20 minutes behind')
    expect(screen.getByText('Notifications waiting').nextSibling).toHaveTextContent('7')
    expect(screen.getByText('Open high-severity alerts').nextSibling).toHaveTextContent('1')
  })
})

describe('navigation', () => {
  it('shows Risk alerts only with risk.review and System health only with reports.read', () => {
    const nav = (perms: string[]) => { cleanup(); mount(<Routes><Route element={<AdminLayout />}><Route index element={<p>home</p>} /></Route></Routes>, staff(perms)); return within(screen.getByRole('navigation', { name: /^primary$/i })) }
    const compliance = nav(['risk.review'])
    expect(compliance.getByRole('link', { name: 'Risk alerts' })).toBeInTheDocument()
    expect(compliance.queryByRole('link', { name: 'System health' })).toBeNull()
    const reports = nav(['reports.read'])
    expect(reports.getByRole('link', { name: 'System health' })).toBeInTheDocument()
    expect(reports.queryByRole('link', { name: 'Risk alerts' })).toBeNull()
  })
})
