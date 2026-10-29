import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A light guard on the deployment Blueprint's safety-critical settings. (Full schema validation against Render's published
// JSON schema is a manual step in docs/DEPLOYMENT.md; there is no YAML parser in the project's dependencies.)
const yaml = readFileSync(path.resolve(__dirname, '../../render.yaml'), 'utf8');

/** The `- key: NAME` entry of the Blueprint, up to the next entry. */
function envEntry(name: string): string {
  const match = new RegExp(`- key: ${name}\\n((?:[ ]{8,}.*\\n?)*)`).exec(yaml);
  if (!match) throw new Error(`render.yaml has no ${name} entry`);
  return match[1]!;
}

describe('render.yaml (demo Blueprint)', () => {
  it('turns development endpoints and the fake clock off in production', () => {
    expect(envEntry('NODE_ENV')).toMatch(/value: production/);
    expect(envEntry('ENABLE_DEV_ENDPOINTS')).toMatch(/value: "false"/);
    expect(yaml).not.toMatch(/FAKE_CLOCK|ALLOW_DB_RESET/);
  });

  it('keeps secrets out of the file: the JWT secret is generated and the database URL is referenced', () => {
    expect(envEntry('JWT_SECRET')).toMatch(/generateValue: true/);
    expect(envEntry('JWT_SECRET')).not.toMatch(/value:/);
    expect(envEntry('DATABASE_URL')).toMatch(/fromDatabase:/);
    expect(yaml).not.toMatch(/postgres(ql)?:\/\//);
    expect(yaml).not.toMatch(/password/i);
  });

  it('asks for the two deployment URLs instead of guessing them, so CORS is never a wildcard', () => {
    expect(envEntry('CORS_ORIGINS')).toMatch(/sync: false/);
    expect(envEntry('VITE_API_URL')).toMatch(/sync: false/);
    expect(yaml).not.toMatch(/value: "?\*"?\s*$/m);
  });

  it('trusts exactly one proxy hop (Render\'s load balancer), never every hop', () => {
    expect(envEntry('TRUST_PROXY')).toMatch(/value: "1"/);
  });

  it('wires the health check, SPA fallback and the free plans', () => {
    expect(yaml).toMatch(/healthCheckPath: \/health/);
    expect(yaml).toMatch(/type: rewrite\n\s+source: \/\*\n\s+destination: \/index\.html/);
    expect(yaml.match(/plan: free/g)).toHaveLength(2); // database + API (static sites have no plan)
  });

  it('uses scripts that exist in the workspace and installs dev dependencies for the build', () => {
    const rootScripts = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    const serverScripts = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { scripts: Record<string, string> };
    const clientScripts = JSON.parse(readFileSync(path.resolve(__dirname, '../../client/package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(rootScripts.scripts).toBeDefined();
    for (const script of ['build', 'start', 'db:migrate', 'db:seed']) expect(serverScripts.scripts[script], script).toBeDefined();
    expect(clientScripts.scripts.build).toBeDefined();
    expect(yaml).toContain('npm ci --include=dev && npm run build -w server');
    expect(yaml).toContain('npm ci --include=dev && npm run build -w client');
    expect(yaml).toContain('npm run db:migrate -w server && npm run db:seed -w server && npm run start -w server');
    expect(yaml).toMatch(/staticPublishPath: client\/dist/);
  });
});
