import type { Request, Response } from 'express';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { unauthenticated } from '../lib/errors';
import * as authService from '../services/authService';

const MAX_PASSWORD_BYTES = 72;

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

const registerSchema = z
  .object({
    email,
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .refine((p) => Buffer.byteLength(p, 'utf8') <= MAX_PASSWORD_BYTES, `Password must be at most ${MAX_PASSWORD_BYTES} bytes`),
    name: z.string().trim().min(1, 'Name is required').max(100),
  })
  .strict();

// Login deliberately does not reveal password rules; it only bounds the input size.
const loginSchema = z.object({ email, password: z.string().min(1).max(1024) }).strict();

export function authController(deps: authService.AuthDeps) {
  return {
    register: async (req: Request, res: Response): Promise<void> => {
      const input = parseInput(registerSchema, req.body);
      res.status(201).json(await authService.register(deps, input));
    },
    login: async (req: Request, res: Response): Promise<void> => {
      const input = parseInput(loginSchema, req.body);
      res.status(200).json(await authService.login(deps, input));
    },
    me: (req: Request, res: Response): void => {
      if (!req.user) throw unauthenticated();
      res.status(200).json({ user: req.user });
    },
  };
}
