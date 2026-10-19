import type { MetricUsage } from '../api/types';
import { formatLimit, metricLabel } from '../lib/format';

/** Usage versus the plan limit as reported by the server. Unlimited metrics are shown as counts, not as a bar. */
export function UsageBar({ metric }: { metric: MetricUsage }) {
  const label = metricLabel(metric.metric);
  const pct = metric.unlimited || metric.limit === null ? 0 : metric.limit === 0 ? 100 : Math.min(100, Math.round((metric.used / metric.limit) * 100));
  const exhausted = !metric.unlimited && metric.remaining === 0 && metric.limit !== 0;
  const color = exhausted ? 'bg-red-600' : pct >= 80 ? 'bg-amber-500' : 'bg-indigo-600';

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-slate-900">{label}</span>
        <span className="text-slate-700">
          {metric.used.toLocaleString('en-IN')} / {formatLimit(metric.limit)}
          {exhausted && <span className="ml-2 font-semibold text-red-700">Limit reached</span>}
          {metric.limit === 0 && <span className="ml-2 font-semibold text-red-700">Not included</span>}
        </span>
      </div>
      {metric.unlimited ? (
        <p className="mt-1 text-xs text-slate-600">Unlimited on your plan</p>
      ) : (
        <div
          role="progressbar"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={metric.limit ?? 0}
          aria-valuenow={Math.min(metric.used, metric.limit ?? metric.used)}
          aria-valuetext={`${metric.used} of ${metric.limit} used`}
          className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"
        >
          <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}
