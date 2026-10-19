import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import type { Clock } from '../lib/clock';
import { AppError, conflict } from '../lib/errors';
import { issueToken, type TokenSettings } from './tokenService';

export interface AuthDeps {
  pool: Pool;
  clock: Clock;
  tokens: TokenSettings;
  bcryptCost: number;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
  expiresAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: Date;
}

const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  createdAt: row.created_at.toISOString(),
});

const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything beyond this
const dummyHashes = new Map<number, Promise<string>>();

/** A real hash at the configured cost, compared against when the email is unknown so timing doesn't leak existence. */
function dummyHash(cost: number): Promise<string> {
  let hash = dummyHashes.get(cost);
  if (!hash) {
    hash = bcrypt.hash(randomBytes(16).toString('hex'), cost);
    dummyHashes.set(cost, hash);
  }
  return hash;
}

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

function authResult(user: UserRow, deps: AuthDeps): AuthResult {
  const { token, expiresAt } = issueToken(user.id, deps.tokens, deps.clock);
  return { user: toPublicUser(user), token, expiresAt: expiresAt.toISOString() };
}

/** `email` must already be normalized (trimmed, lowercased) and `password` validated by the caller's schema. */
export async function register(deps: AuthDeps, input: { email: string; password: string; name: string }): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(input.password, deps.bcryptCost);
  try {
    const { rows } = await deps.pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [input.email, passwordHash, input.name],
    );
    return authResult(rows[0]!, deps);
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_unique')) {
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err;
  }
}

export async function login(deps: AuthDeps, input: { email: string; password: string }): Promise<AuthResult> {
  const { rows } = await deps.pool.query<UserRow & { password_hash: string }>(
    'SELECT id, email, name, created_at, password_hash FROM users WHERE email = $1',
    [input.email],
  );
  const user = rows[0];
  const hash = user ? user.password_hash : await dummyHash(deps.bcryptCost);
  // Passwords over the bcrypt limit can never be valid (registration rejects them); don't let truncation match.
  const tooLong = Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES;
  const matches = await bcrypt.compare(tooLong ? '' : input.password, hash);
  if (!user || tooLong || !matches) throw invalidCredentials();
  return authResult(user, deps);
}

export async function findUserById(pool: Pool, id: string): Promise<PublicUser | null> {
  const { rows } = await pool.query<UserRow>('SELECT id, email, name, created_at FROM users WHERE id = $1', [id]);
  return rows[0] ? toPublicUser(rows[0]) : null;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505' && 'constraint' in err && err.constraint === constraint;
}
