import type { Request, Response } from 'express';
import { z } from 'zod';
import { unauthenticated } from '../lib/errors';
import { parseInput } from '../lib/validate';
import type { BillingDeps } from '../services/billingOperations';
import * as subscriptions from '../services/subscriptionService';

const planBody = z.object({ planId: z.uuid() }).strict();
const emptyBody = z.object({}).strict().optional();
const cancelBody = z.object({ immediate: z.boolean().optional() }).strict().optional();
const previewQuery = z.object({ planId: z.uuid() });

function userId(req: Request): string {
  if (!req.user) throw unauthenticated();
  return req.user.id;
}

export function subscriptionController(deps: BillingDeps) {
  return {
    plans: async (_req: Request, res: Response): Promise<void> => {
      res.json({ plans: await subscriptions.listPlans(deps) });
    },
    invoices: async (req: Request, res: Response): Promise<void> => {
      res.json({ invoices: await subscriptions.listInvoices(deps, userId(req)) });
    },
    current: async (req: Request, res: Response): Promise<void> => {
      res.json({ subscription: await subscriptions.getCurrentSubscription(deps, userId(req)) });
    },
    history: async (req: Request, res: Response): Promise<void> => {
      res.json({ events: await subscriptions.getHistory(deps, userId(req)) });
    },
    upgradePreview: async (req: Request, res: Response): Promise<void> => {
      const { planId } = parseInput(previewQuery, req.query);
      res.json({ preview: await subscriptions.upgradePreview(deps, userId(req), planId) });
    },
    subscribe: async (req: Request, res: Response): Promise<void> => {
      const { planId } = parseInput(planBody, req.body);
      res.status(201).json({ subscription: await subscriptions.subscribe(deps, userId(req), planId) });
    },
    upgrade: async (req: Request, res: Response): Promise<void> => {
      const { planId } = parseInput(planBody, req.body);
      res.json({ subscription: await subscriptions.upgrade(deps, userId(req), planId) });
    },
    downgrade: async (req: Request, res: Response): Promise<void> => {
      const { planId } = parseInput(planBody, req.body);
      res.json({ subscription: await subscriptions.downgrade(deps, userId(req), planId) });
    },
    removePendingChange: async (req: Request, res: Response): Promise<void> => {
      parseInput(emptyBody, req.body);
      res.json({ subscription: await subscriptions.removePendingChange(deps, userId(req)) });
    },
    pause: async (req: Request, res: Response): Promise<void> => {
      parseInput(emptyBody, req.body);
      res.json({ subscription: await subscriptions.pause(deps, userId(req)) });
    },
    resume: async (req: Request, res: Response): Promise<void> => {
      parseInput(emptyBody, req.body);
      res.json({ subscription: await subscriptions.resume(deps, userId(req)) });
    },
    cancel: async (req: Request, res: Response): Promise<void> => {
      const body = parseInput(cancelBody, req.body);
      res.json({ subscription: await subscriptions.cancel(deps, userId(req), { immediate: body?.immediate === true }) });
    },
    reactivate: async (req: Request, res: Response): Promise<void> => {
      parseInput(emptyBody, req.body);
      res.json({ subscription: await subscriptions.reactivate(deps, userId(req)) });
    },
  };
}
