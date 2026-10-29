import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFlash } from '../context/FlashContext';
import { Banner } from './Banner';
import { Button } from './Button';
import { DemoNotice } from './DemoNotice';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/pricing', label: 'Plans', end: false },
  { to: '/manage', label: 'Manage plan', end: false },
  { to: '/usage', label: 'Usage', end: false },
  { to: '/invoices', label: 'Billing', end: false },
  { to: '/history', label: 'History', end: false },
];

export function Layout() {
  const { user, logout } = useAuth();
  const { flash, clearFlash } = useFlash();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const flashState = useRef<{ target: string; seen: boolean } | null>(null);

  // A confirmation belongs to the page it was raised for: show it there, and drop it once the user has moved on.
  useEffect(() => {
    if (!flash) {
      flashState.current = null;
      return;
    }
    const state = (flashState.current ??= { target: flash.path ?? location.pathname, seen: false });
    if (location.pathname === state.target) state.seen = true;
    else if (state.seen) clearFlash();
  }, [flash, location.pathname, clearFlash]);

  // After a route change move focus to the page so keyboard and screen-reader users start at the top of the new content.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow">
        Skip to main content
      </a>
      <DemoNotice />
      <header className="relative border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="text-lg font-bold tracking-tight text-indigo-700">
            SubCycle
          </Link>
          <button
            type="button"
            className="rounded-md px-3 py-2 text-sm font-medium ring-1 ring-slate-300 md:hidden"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            Menu
          </button>
          <nav id="primary-nav" aria-label="Primary" className={`${menuOpen ? 'block' : 'hidden'} absolute inset-x-0 top-full z-40 border-b border-slate-200 bg-white p-3 md:static md:block md:border-0 md:p-0`}>
            <ul className="flex flex-col gap-1 md:flex-row md:items-center">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={() => setMenuOpen(false)}
                    className={({ isActive }) =>
                      `block rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-600 ${isActive ? 'bg-indigo-50 text-indigo-800' : 'text-slate-700 hover:bg-slate-100'}`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
              <li className="mt-2 flex items-center gap-3 border-t border-slate-200 pt-2 md:ml-3 md:mt-0 md:border-0 md:pt-0">
                <span className="truncate text-xs text-slate-600" title={user?.email}>
                  {user?.email}
                </span>
                <Button variant="secondary" onClick={logout}>
                  Sign out
                </Button>
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 outline-none">
        {flash && (
          <Banner tone={flash.kind === 'success' ? 'success' : 'info'} onDismiss={clearFlash} className="mb-4">
            {flash.text}
          </Banner>
        )}
        <Outlet />
      </main>
    </div>
  );
}
