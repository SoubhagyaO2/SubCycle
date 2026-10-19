export type PlanInterval = 'month' | 'year';

const daysInMonthUtc = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * Adds one calendar interval in UTC, preserving time of day and clamping the day to the target month's last day
 * (Jan 31 + 1 month = Feb 28/29; Feb 29 + 1 year = Feb 28). Never uses local time.
 */
export function addInterval(from: Date, interval: PlanInterval): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const targetYear = interval === 'year' ? y + 1 : m === 11 ? y + 1 : y;
  const targetMonth = interval === 'year' ? m : (m + 1) % 12;
  const day = Math.min(from.getUTCDate(), daysInMonthUtc(targetYear, targetMonth));
  return new Date(
    Date.UTC(targetYear, targetMonth, day, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()),
  );
}
