/** Standard error body: { error: { code, message, details } } (SPEC section 10). */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const validationError = (message: string, details: Record<string, unknown> = {}) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message);
export const paymentRequired = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError(402, code, message, details);
export const notFound = (message = 'Resource not found', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError(409, code, message, details);
export const tooManyRequests = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError(429, code, message, details);

export function internalErrorBody(): ErrorBody {
  return { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: {} } };
}
