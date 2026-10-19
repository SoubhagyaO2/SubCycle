import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Clock } from '../lib/clock';
import { unauthenticated, validationError } from '../lib/errors';
import { parseInput } from '../lib/validate';
import * as demo from '../services/demoService';
import * as history from '../services/historyService';
import * as usage from '../services/usageService';

// Strict: quantity must be a JSON number; the service enforces integer and range with a clear message.
const recordBody = z.object({ metric: z.string(), quantity: z.number() }).strict();
const KEY = /^[\x21-\x7E]{1,255}$/;

function userId(req: Request): string {
  if (!req.user) throw unauthenticated();
  return req.user.id;
}

export function usageController(deps: usage.UsageDeps) {
  return {
    get: async (req: Request, res: Response): Promise<void> => {
      res.json(await usage.getUsage(deps, userId(req)));
    },
    history: async (req: Request, res: Response): Promise<void> => {
      res.json({ periods: await history.getUsageHistory(deps, userId(req)) });
    },
    operations: async (req: Request, res: Response): Promise<void> => {
      res.json({ operations: await history.listOperations(deps, userId(req)) });
    },
    record: async (req: Request, res: Response): Promise<void> => {
      const body = parseInput(recordBody, req.body);
      usage.validateQuantity(body.quantity);
      const key = req.header('Idempotency-Key');
      if (key !== undefined && !KEY.test(key)) throw validationError('Idempotency-Key must be 1-255 printable ASCII characters');
      const result = await usage.recordUsage(deps, { userId: userId(req), metric: body.metric, quantity: body.quantity, source: 'api', requestKey: key ?? null });
      if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
      res.status(result.replayed ? 200 : 201).json({
        usage: result.usage,
        replayed: result.replayed,
        period: { start: result.periodStart.toISOString(), end: result.periodEnd.toISOString() },
      });
    },
  };
}

export function demoController(clock: Clock) {
  return {
    /** Runs AFTER enforceLimit: the report is written on the metered transaction, so it commits with the usage. */
    generateReport: async (req: Request, res: Response): Promise<void> => {
      if (!req.meter) throw new Error('enforceLimit must run before this handler');
      const report = await demo.generateReport(req.meter, userId(req), clock);
      res.status(201).json({ report, usage: req.meter.usage.usage });
    },
  };
}
