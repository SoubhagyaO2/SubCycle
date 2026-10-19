import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The default 1 s for findBy*/waitFor is too tight on a loaded CI machine; generous limits only cost time when a test fails.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
