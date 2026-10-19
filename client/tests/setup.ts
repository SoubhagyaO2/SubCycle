import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// The default 1 s for findBy*/waitFor is too tight on a loaded CI machine; generous limits only cost time when a test fails.
configure({ asyncUtilTimeout: 10_000 });

/**
 * jsdom reports unsupported behaviour (most importantly a real page navigation: an anchor click or form submit whose
 * default action was not prevented) as a "Not implemented" error that would otherwise only be PRINTED while the test
 * still passes. The app must only navigate client-side, so any such report fails the test that caused it.
 */
const jsdomErrors: string[] = [];
const virtualConsole = (globalThis as unknown as { jsdom?: { virtualConsole: { on(event: string, fn: (err: { message?: string }) => void): void } } }).jsdom?.virtualConsole;
virtualConsole?.on('jsdomError', (err) => jsdomErrors.push(err.message ?? 'unknown jsdom error'));

beforeEach(() => {
  jsdomErrors.length = 0;
});

afterEach(async () => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  // jsdom starts a hyperlink navigation from a 0 ms timer, so let pending timers run before checking.
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (jsdomErrors.length > 0) {
    const problems = jsdomErrors.splice(0).join('; ');
    throw new Error(`jsdom reported an unsupported operation during this test (a hard navigation?): ${problems}`);
  }
});
