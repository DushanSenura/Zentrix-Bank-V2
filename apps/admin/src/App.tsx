import type { ReactElement } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import AccountsPage from './features/accounts/AccountsPage'
import AuditPage from './features/audit/AuditPage'
import LoginPage from './features/auth/LoginPage'
import { CustomerDetailPage, CustomersPage } from './features/customers/CustomersPage'
import DashboardPage from './features/dashboard/DashboardPage'
import KycPage from './features/kyc/KycPage'
import OperationsPage from './features/operations/OperationsPage'
import PaymentsPage from './features/payments/PaymentsPage'
import { CardsAdminPage, DepositsAdminPage, LoansAdminPage } from './features/products/ProductAdminPages'
import ReportsPage from './features/reports/ReportsPage'
import SettingsPage from './features/settings/SettingsPage'
import { RolesPage, StaffPage } from './features/staff/StaffPages'
import AdminLayout, { allowed } from './layouts/AdminLayout'

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

export default function App() {
  return (
    <AuthProvider>
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
          <Route path="reports" element={g(['reports.read'], <ReportsPage />)} />
          <Route path="audit" element={g(['audit.read'], <AuditPage />)} />
          <Route path="staff" element={g(['staff.manage'], <StaffPage />)} />
          <Route path="roles" element={g(['staff.manage'], <RolesPage />)} />
          <Route path="settings" element={g(['settings.manage'], <SettingsPage />)} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
