import type { Interval } from '../api/types';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const inrExact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Amounts are integer paise (INR). */
export function formatMoney(paise: number): string {
  return paise % 100 === 0 ? inr.format(paise / 100) : inrExact.format(paise / 100);
}

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

/** The backend works in UTC; so does the UI, and it says so. */
export function formatDateTime(iso: string): string {
  return `${dateTime.format(new Date(iso))} UTC`;
}
export function formatDate(iso: string): string {
  return `${dateOnly.format(new Date(iso))} UTC`;
}

export function formatInterval(interval: Interval): string {
  return interval === 'month' ? 'month' : 'year';
}

export function formatPrice(priceCents: number, interval: Interval): string {
  return priceCents === 0 ? 'Free' : `${formatMoney(priceCents)} / ${formatInterval(interval)}`;
}

export function formatDuration(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}${hours > 0 ? ` ${hours} h` : ''}`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

const METRIC_LABELS: Record<string, string> = { api_calls: 'API calls', projects: 'Projects', seats: 'Seats' };
export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function formatLimit(value: number | null): string {
  return value === null ? 'Unlimited' : value.toLocaleString('en-IN');
}
