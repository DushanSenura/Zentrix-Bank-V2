import { BarChart3, ClipboardList, CreditCard, Landmark, LayoutDashboard, Lock, Menu, PanelLeftClose, PanelLeftOpen, ScrollText, Settings, ShieldCheck, UserCog, Users, Wallet, ArrowLeftRight, FileCheck2, PiggyBank, LifeBuoy, AlertTriangle, MapPin, ShieldAlert, Activity, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth'
import { applyTheme, loadTheme, type Theme } from '../theme'

interface Item { to: string; label: string; icon: LucideIcon; any: string[]; end?: boolean }
export const NAV: { group: string; items: Item[] }[] = [
  { group: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, any: [], end: true }] },
  { group: 'Customers', items: [
    { to: '/customers', label: 'Customers', icon: Users, any: ['customers.read'] },
    { to: '/kyc', label: 'KYC review', icon: FileCheck2, any: ['kyc.review'] },
    { to: '/accounts', label: 'Accounts', icon: Wallet, any: ['accounts.review', 'customers.read'] },
  ] },
  { group: 'Products', items: [
    { to: '/cards', label: 'Cards', icon: CreditCard, any: ['cards.review'] },
    { to: '/loans', label: 'Loans', icon: Landmark, any: ['loans.review', 'loans.approve'] },
    { to: '/deposits', label: 'Deposits', icon: PiggyBank, any: ['deposits.manage'] },
  ] },
  { group: 'Money', items: [
    { to: '/payments', label: 'Transactions', icon: ArrowLeftRight, any: ['transactions.read'] },
    { to: '/operations', label: 'Ledger operations', icon: ClipboardList, any: ['transactions.adjust', 'transactions.read'] },
    { to: '/reports', label: 'Reports', icon: BarChart3, any: ['reports.read'] },
  ] },
  { group: 'Service', items: [
    { to: '/disputes', label: 'Problem reports', icon: AlertTriangle, any: ['support.manage'] },
    { to: '/tickets', label: 'Support requests', icon: LifeBuoy, any: ['support.manage'] },
    { to: '/branches', label: 'Branches', icon: MapPin, any: ['branches.manage', 'support.manage'] },
  ] },
  { group: 'Governance', items: [
    { to: '/risk', label: 'Risk alerts', icon: ShieldAlert, any: ['risk.review'] },
    { to: '/health', label: 'System health', icon: Activity, any: ['reports.read'] },
    { to: '/audit', label: 'Audit log', icon: ScrollText, any: ['audit.read'] },
    { to: '/staff', label: 'Staff', icon: UserCog, any: ['staff.manage'] },
    { to: '/roles', label: 'Roles', icon: ShieldCheck, any: ['staff.manage'] },
    { to: '/settings', label: 'Settings', icon: Settings, any: ['settings.manage'] },
  ] },
]

/** Whether the signed-in staff member should see a route. Convenience only: the API enforces every permission itself. */
export const allowed = (can: (p: string) => boolean, any: string[]) => any.length === 0 || any.some(can)

function Breadcrumbs() {
  const { pathname } = useLocation()
  const parts = pathname.split('/').filter(Boolean)
  const section = NAV.flatMap((g) => g.items).find((i) => i.to !== '/' && i.to === `/${parts[0]}`)
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
      <Link to="/" className="hover:underline">Zentrix Bank</Link>
      {section && <> <span aria-hidden>›</span> {parts.length > 1 ? <Link to={section.to} className="hover:underline">{section.label}</Link> : <span aria-current="page">{section.label}</span>}</>}
      {section && parts.length > 1 && <> <span aria-hidden>›</span> <span aria-current="page">Details</span></>}
      {!section && parts.length === 0 && <> <span aria-hidden>›</span> <span aria-current="page">Dashboard</span></>}
    </nav>
  )
}

export default function AdminLayout() {
  const { me, logout, can } = useAuth()
  const [theme, setTheme] = useState<Theme>(loadTheme())
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  if (!me) return <Navigate to="/login" replace />

  const link = ({ isActive }: { isActive: boolean }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${isActive ? 'bg-white/20 font-medium' : 'hover:bg-white/10'}`
  return (
    <div className="min-h-screen md:flex">
      <aside className={`${mobileOpen ? 'block' : 'hidden'} bg-navy text-white md:block ${collapsed ? 'md:w-16' : 'md:w-60'} shrink-0 transition-[width] duration-200`} aria-label="Sidebar">
        <div className="flex items-center gap-2 px-4 py-4">
          <Landmark aria-hidden className="shrink-0 text-cyan" />
          {!collapsed && <span className="font-semibold">Zentrix Admin</span>}
        </div>
        <nav aria-label="Primary" className="space-y-4 px-2 pb-4">
          {NAV.map((g) => {
            const items = g.items.filter((i) => allowed(can, i.any))
            if (items.length === 0) return null
            return (
              <div key={g.group}>
                {!collapsed && <div className="px-3 pb-1 text-xs uppercase tracking-wide text-white/50">{g.group}</div>}
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end} className={link} title={i.label} onClick={() => setMobileOpen(false)}>
                    <i.icon aria-hidden size={18} className="shrink-0" />
                    {!collapsed && <span>{i.label}</span>}
                    {collapsed && <span className="sr-only">{i.label}</span>}
                  </NavLink>
                ))}
              </div>
            )
          })}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-3 border-b border-black/10 bg-surface px-6 py-3">
          <button className="rounded-lg p-2 hover:bg-black/5 md:hidden" aria-label="Open menu" onClick={() => setMobileOpen((v) => !v)}><Menu size={20} /></button>
          <button className="hidden rounded-lg p-2 hover:bg-black/5 md:block" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed((v) => !v)}>{collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}</button>
          <span className="rounded-full bg-black/5 px-3 py-1 text-xs text-muted">Simulation environment</span>
          <select aria-label="Theme" value={theme} onChange={(e) => { const t = e.target.value as Theme; setTheme(t); applyTheme(t) }} className="ml-auto rounded-lg border border-black/15 bg-surface px-2 py-1.5 text-sm">
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
          <span className="text-sm">{me.fullName ?? me.username}</span>
          <button onClick={logout} className="flex items-center gap-1 rounded-lg bg-navy px-3 py-1.5 text-sm text-white hover:opacity-90"><Lock size={14} aria-hidden /> Sign out</button>
        </header>
        <main className="mx-auto max-w-7xl p-6">
          <Breadcrumbs />
          <Outlet />
        </main>
      </div>
    </div>
  )
}
