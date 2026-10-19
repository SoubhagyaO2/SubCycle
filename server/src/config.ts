import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  FAKE_CLOCK: boolFlag,
  ALLOW_DB_RESET: boolFlag,
});

export type Config = z.infer<typeof schema>;

/** Parses and validates environment variables. Never echoes values (they may contain secrets). */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const config = result.data;
  if (config.NODE_ENV === 'production' && config.FAKE_CLOCK) {
    throw new Error('Invalid environment configuration: FAKE_CLOCK must not be enabled in production');
  }
  return config;
}

/** Loads the repo-root .env (if present) and returns validated config. */
export function loadConfig(): Config {
  dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  return parseConfig(process.env);
}
