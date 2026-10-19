import { createHash } from 'node:crypto';
import {
  ProviderUnavailableError,
  type BillingProvider,
  type ChargeInput,
  type ChargeResult,
  type OperationLookup,
  type RefundInput,
  type RefundResult,
} from './provider';

/** MOCK_BILLING_FAIL: 'never' (default) | 'always' | 'random:<0..1>'. */
export type MockFailMode = { kind: 'never' } | { kind: 'always' } | { kind: 'random'; probability: number };

export function parseMockFailMode(value: string | undefined): MockFailMode {
  const v = (value ?? 'never').trim().toLowerCase();
  if (v === 'never' || v === '') return { kind: 'never' };
  if (v === 'always') return { kind: 'always' };
  const m = /^random:(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(v);
  if (m?.[1]) return { kind: 'random', probability: Number(m[1]) };
  throw new Error('Invalid MOCK_BILLING_FAIL: expected "never", "always" or "random:<probability between 0 and 1>"');
}

interface StoredOperation {
  result: ChargeResult | RefundResult;
  amountCents: number;
  type: 'charge' | 'refund';
}

export interface ChargeGate {
  entered: Promise<void>;
  completed: Promise<void>;
  release(): void;
}
interface InternalGate extends ChargeGate {
  released: Promise<void>;
  enter(): void;
  done(): void;
}

export interface MockProviderOptions {
  failMode?: MockFailMode;
  /** Artificial latency before each charge is processed (lets tests create overlapping requests). */
  latencyMs?: number;
}

/**
 * Deterministic in-memory provider.
 *  - Same idempotency key => same stored result, never a second "charge" (`processedCharges` counts real ones).
 *  - 'random:p' is a pure function of the key, so runs are reproducible.
 *  - Test controls simulate the awkward cases: scripted declines, a response lost AFTER the charge was taken,
 *    a request dropped BEFORE it was taken.
 * It logs nothing.
 */
export class MockProvider implements BillingProvider {
  readonly lookupIsAuthoritative = true;

  private failMode: MockFailMode;
  private latencyMs: number;
  private readonly operations = new Map<string, StoredOperation>();
  private readonly charged = new Map<string, number>(); // providerReference -> amount charged
  private readonly refundedTotals = new Map<string, number>();
  private readonly gates: InternalGate[] = [];
  private scriptedDeclines = 0;
  private lostResponses = 0;
  private droppedRequests = 0;

  /** Every call to charge(), including replays. */
  chargeCalls = 0;
  /** Distinct charges actually "taken" (idempotent replays do not count). */
  processedCharges = 0;
  refundCalls = 0;
  processedRefunds = 0;

  constructor(options: MockProviderOptions = {}) {
    this.failMode = options.failMode ?? { kind: 'never' };
    this.latencyMs = options.latencyMs ?? 0;
  }

  // ---- test / dev controls -------------------------------------------------------------------------------------
  setFailMode(mode: MockFailMode): void {
    this.failMode = mode;
  }
  setLatency(ms: number): void {
    this.latencyMs = ms;
  }
  /**
   * Deterministic concurrency barrier (replaces sleeps in tests). The next charge() call blocks inside the provider until
   * `release()`. `entered` resolves when that call has arrived (so the test KNOWS the request is mid-charge);
   * `completed` resolves when the call has finished processing.
   */
  holdNextCharge(): ChargeGate {
    let enter!: () => void;
    let release!: () => void;
    let done!: () => void;
    const gate: InternalGate = {
      entered: new Promise<void>((r) => (enter = r)),
      released: new Promise<void>((r) => (release = r)),
      completed: new Promise<void>((r) => (done = r)),
      enter: () => enter(),
      done: () => done(),
      release: () => release(),
    };
    this.gates.push(gate);
    return { entered: gate.entered, completed: gate.completed, release: () => release() };
  }
  /** The next n NEW charges are declined (replays of already-stored keys are unaffected). */
  declineNext(n = 1): void {
    this.scriptedDeclines = n;
  }
  /** The next n new charges are processed (money taken) but the response is lost: charge() throws. */
  loseNextResponses(n = 1): void {
    this.lostResponses = n;
  }
  /** The next n new charge requests never reach the provider: charge() throws and nothing is recorded. */
  dropNextRequests(n = 1): void {
    this.droppedRequests = n;
  }
  reset(): void {
    this.operations.clear();
    this.charged.clear();
    this.refundedTotals.clear();
    this.gates.length = 0;
    this.scriptedDeclines = this.lostResponses = this.droppedRequests = 0;
    this.chargeCalls = this.processedCharges = this.refundCalls = this.processedRefunds = 0;
    this.failMode = { kind: 'never' };
    this.latencyMs = 0;
  }
  // --------------------------------------------------------------------------------------------------------------

  async charge(input: ChargeInput): Promise<ChargeResult> {
    this.chargeCalls++;
    const gate = this.gates.shift();
    if (gate) {
      gate.enter();
      await gate.released; // the charge is "in flight": the caller's phase 1 is committed, phase 3 has not started
    }
    try {
      return await this.processCharge(input);
    } finally {
      gate?.done();
    }
  }

  private async processCharge(input: ChargeInput): Promise<ChargeResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const existing = this.operations.get(input.idempotencyKey);
    if (existing) {
      if (existing.type !== 'charge') return { status: 'failed', errorCode: 'idempotency_key_reused', message: 'Key belongs to another operation' };
      if (existing.amountCents !== input.amountCents) {
        return { status: 'failed', errorCode: 'idempotency_key_reused', message: 'Key was used with a different amount' };
      }
      return existing.result;
    }
    if (input.amountCents <= 0 || !Number.isInteger(input.amountCents)) {
      return { status: 'failed', errorCode: 'invalid_amount', message: 'Amount must be a positive integer' };
    }
    if (this.droppedRequests > 0) {
      this.droppedRequests--;
      throw new ProviderUnavailableError('Request timed out before reaching the provider');
    }

    const result = this.decide(input);
    this.operations.set(input.idempotencyKey, { result, amountCents: input.amountCents, type: 'charge' });
    if (result.status === 'succeeded') {
      this.processedCharges++;
      this.charged.set(result.providerReference, input.amountCents);
    }
    if (this.lostResponses > 0) {
      this.lostResponses--;
      throw new ProviderUnavailableError('Response lost after the provider processed the request');
    }
    return result;
  }

  refund(input: RefundInput): Promise<RefundResult> {
    this.refundCalls++;
    const existing = this.operations.get(input.idempotencyKey);
    if (existing) return Promise.resolve(existing.result);

    const charged = this.charged.get(input.providerReference);
    const alreadyRefunded = this.refundedTotals.get(input.providerReference) ?? 0;
    let result: RefundResult;
    if (charged === undefined) {
      result = { status: 'failed', errorCode: 'unknown_charge', message: 'No such charge' };
    } else if (input.amountCents <= 0 || alreadyRefunded + input.amountCents > charged) {
      result = { status: 'failed', errorCode: 'invalid_refund_amount', message: 'Refund exceeds the charged amount' };
    } else {
      result = { status: 'succeeded', providerReference: `mock_re_${digest(input.idempotencyKey)}` };
      this.refundedTotals.set(input.providerReference, alreadyRefunded + input.amountCents);
      this.processedRefunds++;
    }
    this.operations.set(input.idempotencyKey, { result, amountCents: input.amountCents, type: 'refund' });
    return Promise.resolve(result);
  }

  lookup(idempotencyKey: string): Promise<OperationLookup | null> {
    const op = this.operations.get(idempotencyKey);
    if (!op) return Promise.resolve(null);
    if (op.result.status === 'succeeded') {
      return Promise.resolve({ status: 'succeeded', amountCents: op.amountCents, providerReference: op.result.providerReference });
    }
    return Promise.resolve({ status: 'failed', amountCents: op.amountCents, errorCode: op.result.errorCode, message: op.result.message });
  }

  private decide(input: ChargeInput): ChargeResult {
    let decline = false;
    if (this.scriptedDeclines > 0) {
      this.scriptedDeclines--;
      decline = true;
    } else if (this.failMode.kind === 'always') {
      decline = true;
    } else if (this.failMode.kind === 'random') {
      decline = keyFraction(input.idempotencyKey) < this.failMode.probability;
    }
    if (decline) return { status: 'failed', errorCode: 'card_declined', message: 'The payment was declined' };
    return { status: 'succeeded', providerReference: `mock_ch_${digest(input.idempotencyKey)}` };
  }
}

function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Deterministic pseudo-random number in [0, 1) derived from the key. */
function keyFraction(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0x1_0000_0000;
}
