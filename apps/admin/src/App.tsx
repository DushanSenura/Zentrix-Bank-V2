import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth'
import LoginPage from './features/auth/LoginPage'
import DashboardPage from './features/dashboard/DashboardPage'
import AccountsPage from './features/accounts/AccountsPage'
import KycPage from './features/kyc/KycPage'
import AdminLayout from './layouts/AdminLayout'

/** Navigation is permission-aware for convenience only; the API enforces every permission itself. */
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="kyc" element={<KycPage />} />
          <Route path="accounts" element={<AccountsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
