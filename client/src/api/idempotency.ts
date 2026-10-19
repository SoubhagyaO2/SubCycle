import { ApiError } from './client';

/**
 * Idempotency-Key policy (one key per user INTENTION, e.g. "upgrade to plan X"):
 *  - a new intention gets a fresh key;
 *  - a retry of the SAME intention after an UNKNOWN outcome (network error, 5xx, "still in progress") reuses the key,
 *    so the server cannot apply it twice;
 *  - after any DEFINITIVE answer (success, or a 4xx such as a 402 decline) the key is dropped: the server replays a
 *    stored answer for a key, so a genuine second attempt needs a new one.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for very old browsers: 128 random bits as hex.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class IntentKeys {
  private readonly keys = new Map<string, string>();

  /** The key to use for this intention (stable until the intention is settled). */
  keyFor(intent: string): string {
    let key = this.keys.get(intent);
    if (!key) {
      key = newIdempotencyKey();
      this.keys.set(intent, key);
    }
    return key;
  }

  /** Call with the outcome: keeps the key only if the outcome is unknown (so a retry is the same intention). */
  settle(intent: string, error?: unknown): void {
    if (error instanceof ApiError && error.outcomeUnknown) return;
    if (error !== undefined && !(error instanceof ApiError)) return; // unexpected local error: outcome unknown
    this.keys.delete(intent);
  }

  has(intent: string): boolean {
    return this.keys.has(intent);
  }
}
