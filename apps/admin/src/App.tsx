import { lazy, Suspense, type ComponentType, type ReactElement } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import LoginPage from './features/auth/LoginPage'
import AdminLayout, { allowed } from './layouts/AdminLayout'

// Each section is its own chunk, so signing in downloads only the shell and the page being opened.
const page = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T & string) =>
  lazy(async () => ({ default: (await load())[name] as ComponentType }))
const AccountsPage = page(() => import('./features/accounts/AccountsPage'), 'default')
const AuditPage = page(() => import('./features/audit/AuditPage'), 'default')
const CustomersPage = page(() => import('./features/customers/CustomersPage'), 'CustomersPage')
const CustomerDetailPage = page(() => import('./features/customers/CustomersPage'), 'CustomerDetailPage')
const DashboardPage = page(() => import('./features/dashboard/DashboardPage'), 'default')
const KycPage = page(() => import('./features/kyc/KycPage'), 'default')
const OperationsPage = page(() => import('./features/operations/OperationsPage'), 'default')
const PaymentsPage = page(() => import('./features/payments/PaymentsPage'), 'default')
const CardsAdminPage = page(() => import('./features/products/ProductAdminPages'), 'CardsAdminPage')
const DepositsAdminPage = page(() => import('./features/products/ProductAdminPages'), 'DepositsAdminPage')
const LoansAdminPage = page(() => import('./features/products/ProductAdminPages'), 'LoansAdminPage')
const ReportsPage = page(() => import('./features/reports/ReportsPage'), 'default')
const SettingsPage = page(() => import('./features/settings/SettingsPage'), 'default')
const RiskPage = page(() => import('./features/risk/RiskPage'), 'RiskPage')
const SystemHealthPage = page(() => import('./features/risk/RiskPage'), 'SystemHealthPage')
const BranchesPage = page(() => import('./features/support/SupportPages'), 'BranchesPage')
const DisputesPage = page(() => import('./features/support/SupportPages'), 'DisputesPage')
const TicketsPage = page(() => import('./features/support/SupportPages'), 'TicketsPage')
const RolesPage = page(() => import('./features/staff/StaffPages'), 'RolesPage')
const StaffPage = page(() => import('./features/staff/StaffPages'), 'StaffPage')

/** Shows a clear "no access" page instead of a broken screen. The API still enforces the permission on every call. */
function Guard({ any, children }: { any: string[]; children: ReactElement }) {
  const { can } = useAuth()
  if (allowed(can, any)) return children
  return (
    <div role="alert" className="rounded-2xl bg-surface p-8 text-center ring-1 ring-black/5">
      <h1 className="text-xl font-semibold">You do not have access to this page</h1>
      <p className="mt-2 text-sm text-muted">Ask a Bank Administrator if you need this permission.</p>
    </div>
  )
}

const g = (any: string[], el: ReactElement) => <Guard any={any}>{el}</Guard>
const Loading = () => <p role="status" className="p-6 text-muted">Loading…</p>

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="customers" element={g(['customers.read'], <CustomersPage />)} />
          <Route path="customers/:id" element={g(['customers.read'], <CustomerDetailPage />)} />
          <Route path="kyc" element={g(['kyc.review'], <KycPage />)} />
          <Route path="accounts" element={g(['accounts.review', 'customers.read'], <AccountsPage />)} />
          <Route path="cards" element={g(['cards.review'], <CardsAdminPage />)} />
          <Route path="loans" element={g(['loans.review', 'loans.approve'], <LoansAdminPage />)} />
          <Route path="deposits" element={g(['deposits.manage'], <DepositsAdminPage />)} />
          <Route path="payments" element={g(['transactions.read'], <PaymentsPage />)} />
          <Route path="operations" element={g(['transactions.adjust', 'transactions.read'], <OperationsPage />)} />
          <Route path="disputes" element={g(['support.manage'], <DisputesPage />)} />
          <Route path="tickets" element={g(['support.manage'], <TicketsPage />)} />
          <Route path="branches" element={g(['branches.manage', 'support.manage'], <BranchesPage />)} />
          <Route path="risk" element={g(['risk.review'], <RiskPage />)} />
          <Route path="health" element={g(['reports.read'], <SystemHealthPage />)} />
          <Route path="reports" element={g(['reports.read'], <ReportsPage />)} />
          <Route path="audit" element={g(['audit.read'], <AuditPage />)} />
          <Route path="staff" element={g(['staff.manage'], <StaffPage />)} />
          <Route path="roles" element={g(['staff.manage'], <RolesPage />)} />
          <Route path="settings" element={g(['settings.manage'], <SettingsPage />)} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </AuthProvider>
  )
}
