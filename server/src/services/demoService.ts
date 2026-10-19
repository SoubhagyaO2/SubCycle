import type { Meter } from '../middleware/enforceLimit';
import type { Clock } from '../lib/clock';

export interface DemoReport {
  id: string;
  title: string;
  generatedAt: string;
}

/**
 * The demo's metered work. It is a DB write performed on the SAME transaction client as the usage increment
 * (see enforceLimit), so a report exists if and only if its usage was consumed.
 */
export async function generateReport(meter: Meter, userId: string, clock: Clock): Promise<DemoReport> {
  const now = clock.now();
  const title = `Demo report #${meter.usage.usage.used}`;
  const { rows } = await meter.client.query<{ id: string }>(
    `INSERT INTO demo_reports (user_id, subscription_id, usage_event_id, title, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, meter.usage.subscription.id, meter.usage.eventId, title, now],
  );
  return { id: rows[0]!.id, title, generatedAt: now.toISOString() };
}
