import type { ReactNode } from 'react';
import type { Plan } from '../api/types';
import { formatLimit, formatMoney, metricLabel } from '../lib/format';
import { Badge } from './StatusBadge';

export function PlanCard({ plan, badges = [], heading: Heading = 'h3', children }: { plan: Plan; badges?: string[]; /** Heading level, so the page outline has no skipped levels. */ heading?: 'h2' | 'h3'; children?: ReactNode }) {
  return (
    <article className="flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-card" aria-labelledby={`plan-${plan.id}`}>
      <div className="flex items-start justify-between gap-2">
        <Heading id={`plan-${plan.id}`} className="text-lg font-semibold text-ink">
          {plan.name}
        </Heading>
        <div className="flex flex-wrap justify-end gap-1">
          {badges.map((b) => (
            <Badge key={b} tone={b === 'Current plan' ? 'good' : 'neutral'}>
              {b}
            </Badge>
          ))}
        </div>
      </div>
      <p className="mt-2">
        {plan.priceCents === 0 ? (
          <span className="text-3xl font-bold text-ink">Free</span>
        ) : (
          <>
            <span className="text-3xl font-bold text-ink">{formatMoney(plan.priceCents)}</span>
            <span className="text-sm text-muted"> / {plan.interval}</span>
          </>
        )}
      </p>
      <ul className="mt-4 space-y-1 text-sm text-ink-2">
        {Object.entries(plan.limits).map(([metric, limit]) => (
          <li key={metric}>
            <span className="font-medium">{formatLimit(limit)}</span> {metricLabel(metric).toLowerCase()} per {plan.interval}
          </li>
        ))}
      </ul>
      {children && <div className="mt-5 pt-1">{children}</div>}
    </article>
  );
}
