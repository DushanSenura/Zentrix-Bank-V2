import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axe from 'axe-core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth'
import AuditPage from '../features/audit/AuditPage'
import { CustomersPage } from '../features/customers/CustomersPage'
import DashboardPage from '../features/dashboard/DashboardPage'
import { RiskPage, SystemHealthPage } from '../features/risk/RiskPage'
import SettingsPage from '../features/settings/SettingsPage'
import { RolesPage, StaffPage } from '../features/staff/StaffPages'
import { BranchesPage, DisputesPage, TicketsPage } from '../features/support/SupportPages'
import AdminLayout from '../layouts/AdminLayout'
import { setTokens } from '../services/api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ALL = ['customers.read', 'kyc.review', 'accounts.review', 'cards.review', 'loans.review', 'transactions.read', 'transactions.adjust', 'risk.review', 'support.manage', 'staff.manage', 'roles.manage', 'settings.manage', 'branches.manage', 'audit.read', 'reports.read']
const auth: AuthState = { me: { id: 's1', type: 'STAFF', username: 's1', fullName: 'Officer', permissions: ALL }, login: async () => {}, logout: async () => {}, can: (p) => ALL.includes(p) }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setTokens(null, null) })

/** Rules jsdom can evaluate reliably. (Colour contrast needs real layout and is not claimed here.) */
async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  return r.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}x) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)
}

const pages: [string, React.ReactElement][] = [
  ['dashboard', <DashboardPage />], ['customers', <CustomersPage />], ['audit log', <AuditPage />], ['settings', <SettingsPage />], ['staff', <StaffPage />], ['roles', <RolesPage />],
  ['risk alerts', <RiskPage />], ['system health', <SystemHealthPage />], ['problem reports', <DisputesPage />], ['support requests', <TicketsPage />], ['branches', <BranchesPage />],
]

describe('admin accessibility (axe, structural rules)', () => {
  for (const [name, el] of pages) {
    it(`${name}: no violations in the empty/loaded state`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { items: [], sections: [], kpis: [], queues: [], roles: [], permissions: [], groups: [], status: 'OK', warnings: [], outbox: { pending: 0, oldestPendingSeconds: 0, failing: 0 }, notificationsLast24h: 0, scheduledPaymentsOverdue: 0, unfinishedPaymentsOverAnHour: 0, openRiskAlertsBySeverity: {}, queues2: {} })))
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AuthContext.Provider value={auth}><MemoryRouter>{el}</MemoryRouter></AuthContext.Provider>
        </QueryClientProvider>,
      )
      await new Promise((r) => setTimeout(r, 60)) // let the first fetch settle
      expect(await violations()).toEqual([])
    })
  }

  it('the app shell: labelled landmarks, a skip-friendly structure, and keyboard-reachable navigation', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter><Routes><Route element={<AdminLayout />}><Route index element={<h1>Home</h1>} /></Route></Routes></MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )
    expect(await violations()).toEqual([])
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('tabindex')).not.toBe('-1') // nothing is removed from the tab order
  })
})
