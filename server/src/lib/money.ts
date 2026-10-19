/**
 * Integer division of non-negative BigInts, rounding half up, rounding exactly once.
 * Used by proration (Stage 4): round_half_up(a * r / t) == floor((2*a*r + t) / (2*t)).
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  if (numerator < 0n) throw new RangeError('numerator must be non-negative');
  return (2n * numerator + denominator) / (2n * denominator);
}
