import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, internalErrorBody, notFound } from '../lib/errors';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('Route not found', 'ROUTE_NOT_FOUND'));
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  // Body-parser errors (malformed JSON, payload too large) carry a 4xx status.
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : NaN;
  if (status === 400 || status === 413) {
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
    const message = status === 413 ? 'Request body too large' : 'Malformed request body';
    res.status(status).json({ error: { code, message, details: {} } });
    return;
  }
  // Log only the error class/message, never request bodies, headers or tokens.
  console.error('Unhandled error:', err instanceof Error ? `${err.name}: ${err.message}` : 'non-Error thrown');
  res.status(500).json(internalErrorBody());
};
