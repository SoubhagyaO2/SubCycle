import type { z } from 'zod';
import { validationError } from './errors';

/** Parses untrusted input with a Zod schema; failures become a 400 listing field paths and messages (never values). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(body)',
    message: issue.message,
  }));
  throw validationError('Invalid request', { fields });
}
