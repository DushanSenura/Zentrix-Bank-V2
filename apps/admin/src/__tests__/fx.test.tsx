import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth'
import { FxRatesPage } from '../features/fx/FxRatesPage'
import { setTokens } from '../services/api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const auth: AuthState = { me: { id: 's1', type: 'STAFF', username: 's1', fullName: 'Admin', permissions: ['settings.manage'] }, login: async () => {}, logout: async () => {}, can: () => true }
const rates = { spreadBps: 150, base: 'LKR', note: 'Simulated.', items: [{ currency: 'USD', midRate: 320, youPayPerUnit: 324.8, youGetPerUnit: 315.2, updatedAt: null }, { currency: 'EUR', midRate: 350, youPayPerUnit: 355.25, youGetPerUnit: 344.75, updatedAt: '2026-11-20T10:00:00Z' }] }
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuthContext.Provider value={auth}><MemoryRouter><FxRatesPage /></MemoryRouter></AuthContext.Provider></QueryClientProvider>)

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setTokens(null, null) })

describe('exchange rates (staff)', () => {
  it('shows mid, buy and sell rates, and saves a new mid rate only when a positive number is typed', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method, body: init?.body as string | undefined }); return init?.method === 'PUT' ? json(200, rates) : json(200, rates) }))
    mount()
    expect(await screen.findByText('324.80')).toBeInTheDocument()
    expect(screen.getByText('315.20')).toBeInTheDocument()
    expect(screen.getByText(/spread \(1\.50%\)/)).toBeInTheDocument()
    const save = screen.getAllByRole('button', { name: 'Save' })[0]!
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('New mid rate for USD'), '330.5')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toContain('/admin/fx/rates/USD')
    expect(JSON.parse(put.body!)).toEqual({ midRate: 330.5 })
  })

  it('shows the bank\'s refusal when a change is too large', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => (init?.method === 'PUT' ? json(422, { code: 'rate_change_too_large', message: 'A rate cannot change by more than 20 percent at once. Check the figure.' }) : json(200, rates))))
    mount()
    await screen.findByText('324.80')
    await userEvent.type(screen.getByLabelText('New mid rate for USD'), '900')
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!)
    expect(await screen.findByRole('alert')).toHaveTextContent('more than 20 percent')
  })

  it('has no accessibility violations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, rates)))
    mount()
    await screen.findByText('324.80')
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })
})
