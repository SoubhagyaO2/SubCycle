/** past_due keeps access for 72 hours from the first failed renewal (docs/DECISIONS.md B1). */
export const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;

export type SubscriptionStatus = 'active' | 'paused' | 'past_due' | 'canceled';

export interface AccessSnapshot {
  status: SubscriptionStatus;
  pastDueSince: Date | null;
}

export function graceEndsAt(pastDueSince: Date): Date {
  return new Date(pastDueSince.getTime() + GRACE_PERIOD_MS);
}

/**
 * THE access rule, used by the API, usage middleware and (mirrored via server-provided fields) the frontend.
 * active => yes; past_due => only strictly before grace end (blocked at exactly +72h); paused/canceled => no.
 */
export function hasAccess(sub: AccessSnapshot, now: Date): boolean {
  switch (sub.status) {
    case 'active':
      return true;
    case 'past_due':
      return sub.pastDueSince !== null && now.getTime() < graceEndsAt(sub.pastDueSince).getTime();
    case 'paused':
    case 'canceled':
      return false;
  }
}
