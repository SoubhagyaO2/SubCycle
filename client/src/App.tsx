import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoadingState, ErrorState } from './components/States';
import { AuthProvider, useAuth } from './context/AuthContext';
import { FlashProvider } from './context/FlashContext';
import { SubscriptionProvider } from './context/SubscriptionContext';
import { ApiError } from './api/client';
import { BillingPage } from './pages/BillingPage';
import { DashboardPage } from './pages/DashboardPage';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { ManagePlanPage } from './pages/ManagePlanPage';
import { PricingPage } from './pages/PricingPage';
import { UsagePage } from './pages/UsagePage';

/** Everything behind login. The session is validated with the server before any page renders. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { status, retryBootstrap } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <LoadingState label="Checking your session" />
      </div>
    );
  }
  if (status === 'unavailable') {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <ErrorState error={new ApiError(0, 'NETWORK_ERROR', 'We could not reach the server to check your session. You have not been signed out.')} onRetry={retryBootstrap} title="Server unavailable" />
      </div>
    );
  }
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function NotFoundPage() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-2xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 text-sm text-muted">That page does not exist.</p>
      <Link to="/" className="mt-4 inline-block text-sm font-medium text-brand-700 underline underline-offset-2">
        Back to the dashboard
      </Link>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        element={
          <RequireAuth>
            <SubscriptionProvider>
              <Layout />
            </SubscriptionProvider>
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="pricing" element={<PricingPage />} />
        <Route path="manage" element={<ManagePlanPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="invoices" element={<BillingPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/** Providers + routes. The router itself is supplied by the caller (BrowserRouter in main.tsx, MemoryRouter in tests). */
export default function App({ apiBaseUrl }: { apiBaseUrl: string }) {
  return (
    <AuthProvider apiBaseUrl={apiBaseUrl}>
      <FlashProvider>
        <AppRoutes />
      </FlashProvider>
    </AuthProvider>
  );
}
