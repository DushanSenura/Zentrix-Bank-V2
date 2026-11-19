import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth'
import { BranchesPage, DisputesPage, TicketsPage } from '../features/support/SupportPages'
import { setTokens } from '../services/api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const staff = (perms: string[]): AuthState => ({ me: { id: 's1', type: 'STAFF', username: 's1', fullName: 'Agent', permissions: perms }, login: async () => {}, logout: async () => {}, can: (p) => perms.includes(p) })
const mount = (ui: React.ReactElement, auth: AuthState) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}><MemoryRouter>{ui}</MemoryRouter></AuthContext.Provider>
    </QueryClientProvider>,
  )

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setTokens(null, null) })

const dispute = { id: 'd1', reference: 'DP1', reasonCode: 'UNAUTHORISED', description: 'I did not make this payment', status: 'OPEN', customerName: 'Nimal Perera', customerNumber: 'C001', createdAt: new Date().toISOString(), payment: { reference: 'ZX1', amountMinor: 250000, recipient: 'Kamal' } }

describe('problem reports', () => {
  it('needs a written resolution, and only offers a reversal request to staff who may adjust the ledger', async () => {
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined })
      if (init?.method === 'POST') return json(201, { id: 'd1', status: 'REJECTED' })
      return json(200, { items: [dispute] })
    }))
    const { unmount } = mount(<DisputesPage />, staff(['support.manage']))
    expect(await screen.findByText(/I did not make this payment/)).toBeInTheDocument()
    expect(screen.queryByText(/Request reversal/i)).toBeNull() // no transactions.adjust

    const reject = screen.getByRole('button', { name: 'Reject' })
    expect(reject).toBeDisabled() // no resolution yet
    await userEvent.type(screen.getByLabelText(/Resolution for DP1/), 'Authorised with your PIN')
    expect(reject).toBeEnabled()
    await userEvent.click(reject)
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/disputes/d1/decision'))).toBe(true))
    const sent = JSON.parse(calls.find((c) => c.url.includes('/decision'))!.body!)
    expect(sent).toEqual({ decision: 'REJECT', resolution: 'Authorised with your PIN' }) // no reversal flag
    unmount()

    mount(<DisputesPage />, staff(['support.manage', 'transactions.adjust']))
    expect(await screen.findByText(/Request reversal/i)).toBeInTheDocument()
  })

  it('shows API refusals instead of failing silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => (init?.method === 'POST' ? json(409, { code: 'not_reviewable', message: 'This report was already decided' }) : json(200, { items: [dispute] }))))
    mount(<DisputesPage />, staff(['support.manage']))
    await screen.findByText(/I did not make this payment/)
    await userEvent.type(screen.getByLabelText(/Resolution for DP1/), 'Fine, accepted')
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already decided')
  })
})

describe('support requests', () => {
  it('marks internal notes as hidden from the customer and sends them with internal=true', async () => {
    const sent: unknown[] = []
    const detail = { id: 't1', reference: 'ST1', subject: 'Card missing', category: 'CARD', status: 'OPEN', customer: { name: 'Nimal' }, attachments: [], updatedAt: new Date().toISOString(), messages: [
      { id: 'm1', from: 'CUSTOMER', authorName: 'Nimal', body: 'Where is my card?', internal: false, at: new Date().toISOString() },
      { id: 'm2', from: 'STAFF', authorName: 'Agent', body: 'Check ID first', internal: true, at: new Date().toISOString() },
    ] }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { sent.push(JSON.parse(init.body as string)); return json(201, detail) }
      if (url.includes('/admin/tickets/t1')) return json(200, detail)
      return json(200, { items: [{ id: 't1', reference: 'ST1', subject: 'Card missing', category: 'CARD', status: 'OPEN', customerName: 'Nimal', updatedAt: new Date().toISOString() }] })
    }))
    mount(<TicketsPage />, staff(['support.manage']))
    await userEvent.click(await screen.findByRole('button', { name: /Card missing/ }))
    expect(await screen.findByText(/Internal note \(customer cannot see this\)/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Reply'), 'Verified, sending a new one')
    await userEvent.click(screen.getByLabelText('Internal note'))
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(sent).toContainEqual({ body: 'Verified, sending a new one', internal: true }))
  })
})

describe('branches', () => {
  it('shows only what the role may manage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('appointments') ? json(200, { items: [{ id: 'a1', status: 'REQUESTED', purpose: 'Open account', preferredAt: new Date().toISOString(), confirmedFor: null, branch: 'Kandy Main', customerName: 'Nimal', customerNumber: 'C001' }] }) : json(200, { items: [] }))))
    mount(<BranchesPage />, staff(['support.manage']))
    expect(await screen.findByText('Appointment requests')).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: /Add a location/ })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Confirm' })).toBeDisabled() // needs a time
  })
})
