import type { Request, Response } from 'express';
import { z } from 'zod';
import type { FakeClock } from '../lib/clock';
import { validationError } from '../lib/errors';
import { parseInput } from '../lib/validate';
import type { BillingDeps } from '../services/billingOperations';
import { runJobCycle } from '../services/renewalService';

export interface JobSettings {
  reconcileAfterMs: number;
  batchSize: number;
}

const advanceBody = z
  .object({
    ms: z.number().int().min(0).optional(),
    days: z.number().min(0).optional(),
    to: z.iso.datetime().optional(),
  })
  .strict();

/** Development helpers (never registered in production): run the job cycle now, move the fake clock. */
export function devController(deps: BillingDeps, jobs: JobSettings, fakeClock: FakeClock | null) {
  return {
    runRenewals: async (_req: Request, res: Response): Promise<void> => {
      res.json(await runJobCycle(deps, jobs));
    },
    advanceClock: (req: Request, res: Response): void => {
      if (!fakeClock) throw validationError('The fake clock is not enabled (set FAKE_CLOCK=true)', { code: 'FAKE_CLOCK_DISABLED' });
      const body = parseInput(advanceBody, req.body);
      const given = [body.ms, body.days, body.to].filter((v) => v !== undefined).length;
      if (given !== 1) throw validationError('Provide exactly one of ms, days, to');
      const before = fakeClock.now();
      if (body.to !== undefined) {
        const target = new Date(body.to);
        if (target.getTime() < before.getTime()) throw validationError('The clock can only move forward');
        fakeClock.set(target);
      } else {
        fakeClock.advanceMs(body.ms ?? Math.round((body.days ?? 0) * 86_400_000));
      }
      res.json({ before: before.toISOString(), now: fakeClock.now().toISOString() });
    },
  };
}
