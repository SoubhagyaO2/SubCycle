/**
 * INTEGRATION POINT: future Stripe (or other gateway) provider. NOT implemented in v1.
 *
 * What an implementation must do to satisfy BillingProvider (see provider.ts):
 *  - charge(): create a PaymentIntent (or Charge) passing `idempotencyKey` as Stripe's `Idempotency-Key`
 *    header, so a retry of the same attempt can never double-charge. Map a definitive decline to
 *    `{ status: 'failed' }`; let network errors/timeouts/5xx THROW ProviderUnavailableError (unknown outcome).
 *  - lookup(): look the payment up by `metadata.idempotency_key` (store it on creation) or via the
 *    idempotency key's stored result. Stripe keeps idempotency keys ~24h, so set `lookupIsAuthoritative = false`:
 *    "not found" must not be treated as "never happened" until that window makes late completion impossible.
 *  - refund(): create a Refund against the original charge with the refund's own idempotency key.
 *  - Webhooks: a real integration also needs a webhook endpoint (signature-verified, events de-duplicated by
 *    event id) to learn about asynchronous outcomes. That needs an additional table and is out of scope for v1.
 *  - Never log card data, tokens or API keys.
 */
import type { BillingProvider, ChargeInput, ChargeResult, OperationLookup, RefundInput, RefundResult } from './provider';

export class StripeProvider implements BillingProvider {
  readonly lookupIsAuthoritative = false;

  charge(_input: ChargeInput): Promise<ChargeResult> {
    return Promise.reject(new Error('StripeProvider is not implemented in v1'));
  }
  refund(_input: RefundInput): Promise<RefundResult> {
    return Promise.reject(new Error('StripeProvider is not implemented in v1'));
  }
  lookup(_idempotencyKey: string): Promise<OperationLookup | null> {
    return Promise.reject(new Error('StripeProvider is not implemented in v1'));
  }
}
