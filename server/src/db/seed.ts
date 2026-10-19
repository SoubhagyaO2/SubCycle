import type { Pool } from 'pg';

export interface SeedPlan {
  code: string;
  name: string;
  priceCents: number;
  interval: 'month' | 'year';
  limits: Record<string, number>;
}

/** Documented in docs/DECISIONS.md B16. Prices are paise (INR). Limits apply per billing period. */
export const SEED_PLANS: readonly SeedPlan[] = [
  { code: 'free', name: 'Free', priceCents: 0, interval: 'month', limits: { api_calls: 100, projects: 1, seats: 1 } },
  { code: 'pro_monthly', name: 'Pro', priceCents: 49_900, interval: 'month', limits: { api_calls: 5_000, projects: 10, seats: 3 } },
  { code: 'business_monthly', name: 'Business', priceCents: 149_900, interval: 'month', limits: { api_calls: 50_000, projects: 100, seats: 25 } },
  { code: 'pro_yearly', name: 'Pro (Yearly)', priceCents: 499_900, interval: 'year', limits: { api_calls: 60_000, projects: 10, seats: 3 } },
];

/** Idempotent: upserts plans by `code`. Re-running updates rows to the seed values and never duplicates. */
export async function seedPlans(pool: Pool): Promise<number> {
  for (const plan of SEED_PLANS) {
    await pool.query(
      `INSERT INTO plans (code, name, price_cents, interval, limits)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             price_cents = EXCLUDED.price_cents,
             interval = EXCLUDED.interval,
             limits = EXCLUDED.limits,
             updated_at = now()`,
      [plan.code, plan.name, plan.priceCents, plan.interval, JSON.stringify(plan.limits)],
    );
  }
  return SEED_PLANS.length;
}
