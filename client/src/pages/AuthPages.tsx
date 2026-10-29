import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { DemoNotice, PasswordReuseWarning } from '../components/DemoNotice';
import { FormField } from '../components/FormField';
import { useAuth } from '../context/AuthContext';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything longer; the server rejects it

/** Only same-site paths are valid post-login targets (never a full URL or a protocol-relative `//host`). */
export function safeRedirect(target: unknown): string {
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') ? target : '/';
}

export interface FieldErrors {
  email?: string;
  password?: string;
  name?: string;
}

/** Mirrors the server's rules so mistakes are caught before a request; the server stays the authority. */
export function validateCredentials(values: { email: string; password: string; name?: string }, mode: 'login' | 'register'): FieldErrors {
  const errors: FieldErrors = {};
  const email = values.email.trim();
  if (!email) errors.email = 'Enter your email address.';
  else if (!EMAIL.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';

  if (!values.password) errors.password = 'Enter your password.';
  else if (mode === 'register') {
    if (values.password.length < 8) errors.password = 'Use at least 8 characters.';
    else if (new TextEncoder().encode(values.password).length > MAX_PASSWORD_BYTES) errors.password = 'Use at most 72 bytes (fewer characters if you use emoji or accents).';
  }

  if (mode === 'register') {
    const name = (values.name ?? '').trim();
    if (!name) errors.name = 'Enter your name.';
    else if (name.length > 100) errors.name = 'Use at most 100 characters.';
  }
  return errors;
}

function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { status, login, register, sessionMessage, clearSessionMessage } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = safeRedirect((location.state as { from?: unknown } | null)?.from);
  const [values, setValues] = useState({ email: '', password: '', name: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate to={from} replace />;

  const set = (field: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [field]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return; // double submit guard
    const found = validateCredentials(values, mode);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    clearSessionMessage();
    try {
      const email = values.email.trim();
      if (mode === 'login') await login({ email, password: values.password });
      else await register({ email, password: values.password, name: values.name.trim() });
      navigate(from, { replace: true });
    } catch (err) {
      const apiError = err instanceof ApiError ? err : new ApiError(0, 'UNEXPECTED', 'Something went wrong. Please try again.');
      const fields = apiError.fieldErrors;
      setErrors({ ...(fields.email ? { email: fields.email } : {}), ...(fields.password ? { password: fields.password } : {}), ...(fields.name ? { name: fields.name } : {}) });
      setFormError(apiError.message);
      setSubmitting(false);
    }
  };

  const isLogin = mode === 'login';
  return (
    <>
    <DemoNotice />
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-center text-2xl font-bold tracking-tight text-indigo-700">SubCycle</h1>
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">{isLogin ? 'Sign in to your account' : 'Create your account'}</h2>
        {sessionMessage && isLogin && (
          <Banner tone="warn" className="mt-4">
            {sessionMessage}
          </Banner>
        )}
        {formError && (
          <Banner tone="error" className="mt-4">
            {formError}
          </Banner>
        )}
        <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 space-y-4">
          {!isLogin && <FormField label="Name" name="name" autoComplete="name" value={values.name} onChange={set('name')} error={errors.name} />}
          <FormField label="Email" name="email" type="email" autoComplete="email" value={values.email} onChange={set('email')} error={errors.email} />
          <FormField
            label="Password"
            name="password"
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            value={values.password}
            onChange={set('password')}
            error={errors.password}
            {...(!isLogin ? { hint: 'At least 8 characters.' } : {})}
          />
          <Button type="submit" loading={submitting} className="w-full">
            {isLogin ? 'Sign in' : 'Create account'}
          </Button>
        </form>
        {!isLogin && <PasswordReuseWarning />}
        <p className="mt-4 text-center text-sm text-slate-600">
          {isLogin ? (
            <>
              New to SubCycle?{' '}
              <Link to="/register" state={location.state} className="font-medium text-indigo-700 underline underline-offset-2">
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <Link to="/login" state={location.state} className="font-medium text-indigo-700 underline underline-offset-2">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
    </>
  );
}

export const LoginPage = () => <AuthForm mode="login" />;
export const RegisterPage = () => <AuthForm mode="register" />;
