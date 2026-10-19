import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, deferred, err, makeSub, renderApp, signIn, signedInApi, user } from './mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

const authOk = { body: { user, token: 'new-token', expiresAt: '2026-01-01T01:00:00.000Z' } };
const stored = () => window.localStorage.getItem('subcycle.session');

describe('login', () => {
  it('validates before sending anything and shows clear field messages', async () => {
    const api = signedInApi();
    api.install();
    renderApp('/login');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls).toHaveLength(0);
  });

  it('signs in with a trimmed email, stores the session and lands on the dashboard', async () => {
    const api = signedInApi().on('POST /auth/login', authOk);
    api.install();
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), '  alice@example.com ');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    const login = api.callsTo('POST /auth/login')[0]!;
    expect(login.body).toEqual({ email: 'alice@example.com', password: 'correct horse battery' });
    expect(login.headers.authorization).toBeUndefined();
    expect(JSON.parse(stored()!)).toEqual({ token: 'new-token' });
    // later calls carry the new token
    await waitFor(() => expect(api.callsTo('GET /subscriptions/current')[0]!.headers.authorization).toBe('Bearer new-token'));
  });

  it('shows the generic server error for wrong credentials, stays on the form and stores nothing', async () => {
    signedInApi().on('POST /auth/login', err(401, 'INVALID_CREDENTIALS', 'Invalid email or password')).install();
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(stored()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('shows rate limiting and network failures as clear messages', async () => {
    const api = signedInApi().on('POST /auth/login', err(429, 'RATE_LIMITED', 'Too many requests, please try again later'));
    api.install();
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    api.on('POST /auth/login', { networkError: true });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server'));
  });

  it('a double submit sends exactly one request', async () => {
    const gate = deferred();
    const api = signedInApi().on('POST /auth/login', { ...authOk, gate: gate.promise });
    api.install();
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    const button = screen.getByRole('button', { name: 'Sign in' });
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    gate.resolve();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(api.callsTo('POST /auth/login')).toHaveLength(1);
  });
});

describe('register', () => {
  it('enforces the password rules (8+ characters, at most 72 bytes) and requires a name', async () => {
    const api = signedInApi();
    api.install();
    renderApp('/register');
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.type(screen.getByLabelText('Password'), '1234567');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(screen.getByText('Enter your name.')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), '😀'.repeat(25)); // 25 chars but 100 bytes
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/at most 72 bytes/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('creates the account and signs in', async () => {
    const api = signedInApi(null).on('POST /auth/register', { status: 201, ...authOk });
    api.install();
    renderApp('/register');
    await userEvent.type(screen.getByLabelText('Name'), ' Alice ');
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(api.callsTo('POST /auth/register')[0]!.body).toEqual({ email: 'alice@example.com', password: 'correct horse battery', name: 'Alice' });
    expect(await screen.findByText(/don't have a subscription yet/i)).toBeInTheDocument();
  });

  it('shows the duplicate-email error and server field errors', async () => {
    const api = signedInApi().on('POST /auth/register', err(409, 'EMAIL_TAKEN', 'An account with this email already exists'));
    api.install();
    renderApp('/register');
    await userEvent.type(screen.getByLabelText('Name'), 'Alice');
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An account with this email already exists');

    api.on('POST /auth/register', err(400, 'VALIDATION_ERROR', 'Invalid request', { fields: [{ path: 'email', message: 'Invalid email address' }] }));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Invalid email address')).toBeInTheDocument();
  });
});

describe('persistent login and expired sessions', () => {
  it('a stored token is validated with the server and the user goes straight to the dashboard', async () => {
    signIn('stored-token');
    const api = signedInApi();
    api.install();
    renderApp('/');
    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(api.callsTo('GET /auth/me')[0]!.headers.authorization).toBe('Bearer stored-token');
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('an expired token on load returns to the login screen with an explanation, clears the token and does not crash', async () => {
    signIn('old-token');
    signedInApi().on('GET /auth/me', err(401, 'TOKEN_EXPIRED', 'Token has expired')).install();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in to your account' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has expired');
    expect(stored()).toBeNull();
  });

  it('a session that expires mid-use sends the user to login with a message', async () => {
    signIn();
    signedInApi().on('GET /usage', err(401, 'TOKEN_EXPIRED', 'Token has expired')).install();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    await userEvent.click(screen.getByRole('link', { name: 'Usage' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to your account' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('expired');
    expect(stored()).toBeNull();
  });

  it('if the server is unreachable while checking the session the user is NOT logged out, and can retry', async () => {
    signIn('keep-me');
    const api = signedInApi().on('GET /auth/me', { networkError: true });
    api.install();
    renderApp('/');
    expect(await screen.findByText('Server unavailable')).toBeInTheDocument();
    expect(stored()).not.toBeNull();
    api.on('GET /auth/me', { body: { user } });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('sign out clears the session and returns to login', async () => {
    signIn();
    signedInApi().install();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to your account' })).toBeInTheDocument();
    expect(stored()).toBeNull();
  });

  it('protected pages redirect anonymous visitors to login and come back after signing in', async () => {
    const api = signedInApi(makeSub()).on('POST /auth/login', authOk);
    api.install();
    renderApp('/manage');
    expect(await screen.findByRole('heading', { name: 'Sign in to your account' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Manage plan' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Manage plan' })).toHaveAttribute('aria-current', 'page');
  });

  it('the API base URL is the configured one (no hardcoded host)', async () => {
    const api = signedInApi().on('POST /auth/login', authOk);
    api.install();
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Dashboard' });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith(API))).toBe(true);
  });
});
