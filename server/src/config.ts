import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/** Fixed, NON-secret value so the project runs out of the box in dev/test. Rejected in production. */
export const DEV_JWT_SECRET = 'subcycle-insecure-development-only-secret-do-not-use-in-production';
const MIN_PRODUCTION_SECRET_LENGTH = 32;

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
  JWT_SECRET: z.string().optional(),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).optional(),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(15 * 60 * 1000),
});

type RawConfig = z.infer<typeof schema>;
export type Config = Omit<RawConfig, 'JWT_SECRET' | 'BCRYPT_COST'> & { JWT_SECRET: string; BCRYPT_COST: number };

/** Parses and validates environment variables. Never echoes values (they may contain secrets). */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const raw = result.data;
  const production = raw.NODE_ENV === 'production';
  if (production && raw.FAKE_CLOCK) {
    throw new Error('Invalid environment configuration: FAKE_CLOCK must not be enabled in production');
  }
  let secret = raw.JWT_SECRET;
  if (production) {
    if (!secret || secret.length < MIN_PRODUCTION_SECRET_LENGTH || secret === DEV_JWT_SECRET) {
      throw new Error(`Invalid environment configuration: JWT_SECRET must be set to at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
    }
  } else {
    secret = secret && secret.length > 0 ? secret : DEV_JWT_SECRET;
  }
  const bcryptCost = raw.BCRYPT_COST ?? (raw.NODE_ENV === 'test' ? 4 : 12);
  if (production && bcryptCost < 10) {
    throw new Error('Invalid environment configuration: BCRYPT_COST must be at least 10 in production');
  }
  return { ...raw, JWT_SECRET: secret, BCRYPT_COST: bcryptCost };
}

/** Loads the repo-root .env (if present) and returns validated config. */
export function loadConfig(): Config {
  dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  return parseConfig(process.env);
}
