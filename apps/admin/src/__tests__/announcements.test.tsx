import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth'
import { AnnouncementsPage } from '../features/support/AnnouncementsPage'
import { setTokens } from '../services/api'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const auth: AuthState = { me: { id: 's1', type: 'STAFF', username: 's1', fullName: 'Admin', permissions: ['settings.manage'] }, login: async () => {}, logout: async () => {}, can: () => true }
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuthContext.Provider value={auth}><MemoryRouter><AnnouncementsPage /></MemoryRouter></AuthContext.Provider></QueryClientProvider>)

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setTokens(null, null) })

describe('announcements (staff)', () => {
  it('sends only after the staff member confirms, with the chosen type', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method, body: init?.body as string | undefined }); return init?.method === 'POST' ? json(202, { recipients: 12 }) : json(200, { items: [] }) }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mount()
    const send = await screen.findByRole('button', { name: 'Send to all customers' })
    expect(send).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'OFFER')
    await userEvent.type(screen.getByLabelText('Title'), 'Festive offer')
    await userEvent.type(screen.getByLabelText('Message'), 'Zero fees this week.')
    await userEvent.click(send)
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!)).toEqual({ kind: 'OFFER', title: 'Festive offer', body: 'Zero fees this week.' })
    expect(await screen.findByRole('status')).toHaveTextContent('Sent to 12 customers')
  })

  it('does nothing when the staff member declines the confirmation', async () => {
    const fetchMock = vi.fn(async () => json(200, { items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount()
    await userEvent.type(await screen.findByLabelText('Title'), 'Notice')
    await userEvent.type(screen.getByLabelText('Message'), 'Hello there')
    await userEvent.click(screen.getByRole('button', { name: 'Send to all customers' }))
    expect(fetchMock.mock.calls.every((c) => (c as unknown[])[1] === undefined || ((c as unknown[])[1] as RequestInit).method !== 'POST')).toBe(true)
  })

  it('has no accessibility violations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { items: [{ at: '2026-11-20T10:00:00Z', kind: 'NOTICE', title: 'Holiday hours', recipients: 4 }] })))
    mount()
    await screen.findByText('Holiday hours')
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })
})
