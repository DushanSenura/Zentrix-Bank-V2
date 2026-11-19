import { Landmark } from 'lucide-react'
import { Outlet } from 'react-router-dom'

export default function AdminLayout() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-3 bg-navy px-6 py-4 text-white">
        <Landmark aria-hidden className="text-cyan" />
        <span className="text-lg font-semibold">Zentrix Bank · Administration</span>
        <span className="ml-auto rounded-full bg-white/10 px-3 py-1 text-xs">Simulation environment</span>
      </header>
      <main className="mx-auto max-w-6xl p-6">
        <Outlet />
      </main>
    </div>
  )
}
