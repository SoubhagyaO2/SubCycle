// Starts the built API and the built web app, runs the browser checks, and always stops both again.
// Prerequisites: PostgreSQL reachable at DATABASE_URL (npm run db:up locally), `npm run build`, and in e2e/: npm ci && npx playwright install chromium.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.env.E2E_API_PORT ?? 4010);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const windows = process.platform === 'win32';

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: windows, ...opts });
const children = [];

function stop(child) {
  if (!child.pid) return;
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
async function waitFor(url, label) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

let exitCode = 1;
try {
  if (sh('npm', ['run', 'db:migrate']).status !== 0 || sh('npm', ['run', 'db:seed']).status !== 0) throw new Error('migrate/seed failed (is PostgreSQL up?)');

  const api = spawn(process.execPath, ['server/dist/server.js'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(API_PORT), RUN_JOBS: 'false', AUTH_RATE_LIMIT_MAX: '100000', USAGE_RATE_LIMIT_MAX: '100000' },
  });
  children.push(api);
  const web = spawn(windows ? 'npx.cmd' : 'npx', ['vite', 'preview', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: path.join(root, 'client'),
    stdio: 'inherit',
    shell: windows,
    env: { ...process.env, VITE_PROXY_TARGET: `http://localhost:${API_PORT}` },
  });
  children.push(web);
  await waitFor(`http://localhost:${API_PORT}/health`, 'API');
  await waitFor(`http://localhost:${WEB_PORT}/`, 'web app');

  const result = spawnSync(process.execPath, [path.join('e2e', 'browser-check.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, BASE: `http://localhost:${WEB_PORT}` },
  });
  exitCode = result.status ?? 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
} finally {
  for (const c of children) stop(c);
}
process.exit(exitCode);
