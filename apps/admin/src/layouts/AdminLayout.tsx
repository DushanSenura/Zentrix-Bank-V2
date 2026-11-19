import { Landmark } from 'lucide-react'
import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth'

export default function AdminLayout() {
  const { me, logout, can } = useAuth()
  if (!me) return <Navigate to="/login" replace />
  const link = ({ isActive }: { isActive: boolean }) => `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-white/20' : 'hover:bg-white/10'}`
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-3 bg-navy px-6 py-4 text-white">
        <Landmark aria-hidden className="text-cyan" />
        <span className="text-lg font-semibold">Zentrix Bank · Administration</span>
        <nav className="ml-6 flex gap-1">
          <NavLink to="/" end className={link}>Status</NavLink>
          {can('kyc.review') && <NavLink to="/kyc" className={link}>KYC review</NavLink>}
        </nav>
        <span className="ml-auto text-sm">{me.fullName ?? me.username}</span>
        <button onClick={logout} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">Sign out</button>
      </header>
      <main className="mx-auto max-w-6xl p-6"><Outlet /></main>
    </div>
  )
}
