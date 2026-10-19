/** past_due keeps access for 72 hours from the first failed renewal (docs/DECISIONS.md B1). */
export const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;

export type SubscriptionStatus = 'active' | 'paused' | 'past_due' | 'canceled';

export interface AccessSnapshot {
  status: SubscriptionStatus;
  pastDueSince: Date | null;
  /** The stored end of the paid period. */
  currentPeriodEnd: Date;
}

export function graceEndsAt(pastDueSince: Date): Date {
  return new Date(pastDueSince.getTime() + GRACE_PERIOD_MS);
}

/**
 * THE access rule, used by the API, usage middleware and (mirrored via server-provided fields) the frontend.
 *  - active   => only STRICTLY BEFORE the stored period end. At exactly current_period_end access stops, whether or not
 *                the renewal job has run yet; the job restores it (new period) or moves the subscription to past_due/canceled.
 *  - past_due => only strictly before grace end (blocked at exactly +72h); the (already ended) period is irrelevant.
 *  - paused / canceled => no.
 * See docs/DECISIONS.md B19.
 */
export function hasAccess(sub: AccessSnapshot, now: Date): boolean {
  switch (sub.status) {
    case 'active':
      return now.getTime() < sub.currentPeriodEnd.getTime();
    case 'past_due':
      return sub.pastDueSince !== null && now.getTime() < graceEndsAt(sub.pastDueSince).getTime();
    case 'paused':
    case 'canceled':
      return false;
  }
}
