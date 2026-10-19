import { divRoundHalfUp } from './money';

export interface ProrationInput {
  oldPriceCents: number;
  newPriceCents: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}

export interface Proration {
  amountCents: number;
  remainingMs: number;
  totalMs: number;
}

/**
 * Upgrade proration (SPEC section 7), in integer paise with BigInt:
 *   amount_due = max(0, round_half_up((new - old) * remaining_ms / total_ms))
 * `remaining_ms` comes from the actual stored period (not whole days, not a fixed month length) and is clamped to
 * [0, total_ms]. Rounding happens exactly once, on the final quotient.
 */
export function computeProration(input: ProrationInput): Proration {
  const totalMs = input.periodEnd.getTime() - input.periodStart.getTime();
  if (!(totalMs > 0)) throw new RangeError('period end must be after period start');
  const remainingMs = Math.min(Math.max(input.periodEnd.getTime() - input.now.getTime(), 0), totalMs);
  const diff = input.newPriceCents - input.oldPriceCents;
  if (diff <= 0 || remainingMs === 0) return { amountCents: 0, remainingMs, totalMs };
  const amount = divRoundHalfUp(BigInt(diff) * BigInt(remainingMs), BigInt(totalMs));
  return { amountCents: Number(amount), remainingMs, totalMs };
}
