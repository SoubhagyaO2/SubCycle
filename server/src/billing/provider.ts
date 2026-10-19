/**
 * Billing provider abstraction (SPEC section 8).
 *
 * Contract every implementation (MockProvider now, StripeProvider later) must honour:
 *  - `idempotencyKey` identifies ONE payment attempt. Calling charge() again with the same key must return the
 *    same result and must never charge twice.
 *  - A thrown error means the OUTCOME IS UNKNOWN (timeout, connection reset, 5xx). Callers must not treat it as a
 *    failure and must never retry with a different key; they reconcile via lookup() instead.
 *  - A returned `{ status: 'failed' }` is a DEFINITIVE decline.
 *  - Implementations must never log card/payment details or secrets.
 */

export interface ChargeInput {
  amountCents: number;
  idempotencyKey: string;
  userId: string;
  /** null for an initial subscription charge, before the subscription row exists. */
  subscriptionId: string | null;
  description: string;
}

export type ChargeResult =
  | { status: 'succeeded'; providerReference: string }
  | { status: 'failed'; errorCode: string; message: string };

export interface RefundInput {
  providerReference: string;
  amountCents: number;
  idempotencyKey: string;
}

export type RefundResult =
  | { status: 'succeeded'; providerReference: string }
  | { status: 'failed'; errorCode: string; message: string };

/** What the provider knows about an idempotency key. */
export interface OperationLookup {
  status: 'succeeded' | 'failed';
  amountCents: number;
  providerReference?: string;
  errorCode?: string;
  message?: string;
}

export interface BillingProvider {
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Returns null if the provider has no record of this key (never received it, or not yet processed). */
  lookup(idempotencyKey: string): Promise<OperationLookup | null>;
  /**
   * true  => "lookup() returned null" definitively means the operation did not and will not happen.
   * false => null may just mean "not visible yet"; the reconciler must not give up on such operations.
   */
  readonly lookupIsAuthoritative: boolean;
}

/** Thrown by providers when the outcome of a call cannot be determined. */
export class ProviderUnavailableError extends Error {
  constructor(message = 'Billing provider did not respond') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
