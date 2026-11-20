import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth'
import LoginPage from '../features/auth/LoginPage'

const signedOut: AuthState = { me: null, login: async () => {}, logout: async () => {}, can: () => false }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const mount = () => render(<AuthContext.Provider value={signedOut}><MemoryRouter><LoginPage /></MemoryRouter></AuthContext.Provider>)
const demo = { accounts: [
  { username: 'admin.demo', password: 'Zx-demo-pass-1', kind: 'STAFF', role: 'Super Administrator', fullName: 'Demo Admin', mfaCode: '123456', mfaSecondsLeft: 20 },
  { username: 'amaya.demo', password: 'customer-pass', kind: 'CUSTOMER', role: 'Customer', fullName: 'Amaya' },
] }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('demo accounts on the sign-in page', () => {
  it('lists the staff demo accounts in development and fills the form on request (customers are not shown in the portal)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, demo)))
    mount()
    expect(await screen.findByText('Super Administrator')).toBeInTheDocument()
    expect(screen.getByText('Zx-demo-pass-1')).toBeInTheDocument()
    expect(screen.getByText('123456')).toBeInTheDocument()
    expect(screen.queryByText('amaya.demo')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Fill sign-in with Super Administrator/ }))
    expect(screen.getByLabelText(/Username or email/)).toHaveValue('admin.demo')
    expect(screen.getByLabelText(/^Password/)).toHaveValue('Zx-demo-pass-1')
  })

  it('shows nothing when the server says no (staging and production answer 404)', async () => {
    const f = vi.fn(async () => json(404, { code: 'not_found', message: 'Not found' }))
    vi.stubGlobal('fetch', f)
    mount()
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(screen.queryByText(/Demo staff accounts/)).toBeNull()
  })

  it('never even asks in a production build', async () => {
    vi.stubEnv('DEV', false)
    const f = vi.fn(async () => json(200, demo))
    vi.stubGlobal('fetch', f)
    mount()
    await new Promise((r) => setTimeout(r, 50))
    expect(f).not.toHaveBeenCalled()
    expect(screen.queryByText(/Demo staff accounts/)).toBeNull()
  })
})
