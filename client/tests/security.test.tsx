import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { safeRedirect } from '../src/pages/AuthPages';
import { API, PRO, err, makeSub, renderApp, signIn, signedInApi, user } from './mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

const HOSTILE = [
  '<img src=x onerror="window.__xss=1">',
  '<script>window.__xss=1</script>',
  '"><svg/onload=window.__xss=1>',
  '<a href="javascript:window.__xss=1">click</a>',
];
const injected = () => document.body.querySelectorAll('img[src="x"], script, svg[onload], a[href^="javascript:"], [onerror], [onload]');

describe('hostile data is rendered as text, never as markup', () => {
  it('plan names, descriptions, usage metrics and the signed-in email', async () => {
    signIn();
    const evilPlan = { ...PRO, name: HOSTILE[0]! };
    const api = signedInApi(makeSub({ plan: evilPlan }));
    api.on('GET /auth/me', { body: { user: { ...user, email: `${HOSTILE[2]}@example.com`, name: HOSTILE[1]! } } });
    api.on('GET /plans', { body: { plans: [evilPlan, { ...PRO, id: 'p2', name: HOSTILE[1]! }] } });
    api.on('GET /usage', {
      body: { subscription: { id: 's', status: 'active', accessAllowed: true, graceEndsAt: null }, period: { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' }, usage: [{ metric: 'api_calls', used: 1, limit: 5, remaining: 4, unlimited: false }] },
    });
    api.install();
    renderApp('/');
    expect(await screen.findByText(HOSTILE[0]!)).toBeInTheDocument(); // visible as literal text
    expect(screen.getByText(new RegExp('svg/onload', 'i'))).toBeInTheDocument();
    expect(injected()).toHaveLength(0);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('invoice descriptions, event data, API error messages and flash messages', async () => {
    signIn();
    const api = signedInApi(makeSub());
    api.on('GET /invoices', { body: { invoices: [{ id: 'i', subscriptionId: 's', kind: 'renewal', status: 'paid', amountCents: 100, description: HOSTILE[0]!, billingPeriodStart: '2026-02-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' }] } });
    api.on('GET /billing/operations', { body: { operations: [{ id: 'o', type: 'charge', status: 'failed', kind: 'renewal', amountCents: 100, attempt: 1, reason: null, errorMessage: HOSTILE[1]!, invoiceId: null, refundOfOperationId: null, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }] } });
    api.on('GET /subscriptions/history', { body: { events: [{ id: 'e', subscriptionId: 's', type: HOSTILE[2]!, fromStatus: null, toStatus: null, meta: { reason: HOSTILE[3]! }, createdAt: '2026-01-01T00:00:00.000Z' }] } });
    api.install();
    renderApp('/invoices');
    expect(await screen.findByText(HOSTILE[0]!, { selector: 'span' })).toBeInTheDocument();
    expect(await screen.findAllByText(HOSTILE[1]!)).not.toHaveLength(0);
    expect(injected()).toHaveLength(0);

    cleanup(); // fresh DOM for the next screen
    renderApp('/history');
    expect(await screen.findByText(/svg\/onload/i)).toBeInTheDocument();
    expect(injected()).toHaveLength(0);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('a server error message containing markup is shown as text in the login form', async () => {
    signedInApi().on('POST /auth/login', err(401, 'INVALID_CREDENTIALS', HOSTILE[0]!)).install();
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(HOSTILE[0]!);
    expect(injected()).toHaveLength(0);
  });
});

describe('post-login redirects stay on this site', () => {
  it.each([
    ['/manage', '/manage'],
    ['/manage?plan=abc', '/manage?plan=abc'],
    ['/', '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    // eslint-disable-next-line no-script-url -- hostile test fixture
    ['javascript:alert(1)', '/'],
    ['', '/'],
    [undefined, '/'],
    [42, '/'],
    [{ a: 1 }, '/'],
  ])('safeRedirect(%j) -> %s', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });

  it('a crafted "from" in the router state cannot send the user to another site after login', async () => {
    const api = signedInApi().on('POST /auth/login', { body: { user, token: 't', expiresAt: '2026-01-01T01:00:00.000Z' } });
    api.install();
    render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '//evil.example/steal' } }]}>
        <App apiBaseUrl={API} />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});

describe('the client source contains no raw-HTML or dynamic-code escape hatches', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(tsx?|html)$/.test(f) ? [p] : [];
    });

  it.each([
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['innerHTML / outerHTML', /\.(inner|outer)HTML/],
    ['insertAdjacentHTML', /insertAdjacentHTML/],
    ['document.write', /document\.write/],
    ['eval / new Function', /\beval\s*\(|new Function\s*\(/],
    ['script URLs', /javascript:/i],
    ['target=_blank without noopener', /target=["']_blank["'](?![^>]*noopener)/],
  ])('no %s in client/src', (_name, pattern) => {
    for (const file of files(path.resolve(here, '../src'))) {
      expect(readFileSync(file, 'utf8'), path.relative(here, file)).not.toMatch(pattern);
    }
  });

  it('the session token is only ever stored under the single documented key', () => {
    const uses = files(path.resolve(here, '../src')).filter((f) => /localStorage|sessionStorage/.test(readFileSync(f, 'utf8')));
    expect(uses.map((f) => path.basename(f))).toEqual(['storage.ts']);
  });
});
