// The error contract every response follows (see middleware/errorHandler.ts):
//   { success: false, message, requestId }   with a status from CLIENT_STATUSES only.
// Callers see one of these messages for anything that is not their own mistake; the real cause is
// logged (and alerted) under the same requestId.

export const GENERIC_MESSAGE = 'Something went wrong. Please try again later.';
export const UNAVAILABLE_MESSAGE = 'Service temporarily unavailable, please retry';

// Statuses a client can ever see on an error: bad input, not signed in, not found, conflict,
// throttled, our own failure, and Shopify being down.
export const CLIENT_STATUSES: ReadonlySet<number> = new Set([400, 401, 404, 409, 429, 500, 502]);
// The ones whose message is written for the caller and is passed through as-is.
export const PASS_THROUGH_STATUSES: ReadonlySet<number> = new Set([400, 401, 404, 409, 429]);

// Server misconfiguration (a missing env value, a rejected Shopify credential, a missing app
// scope): the caller cannot fix it and must not learn about it - it is answered with a generic
// 500, and logged + alerted with the real reason.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// An error that carries the HTTP status it should be answered with.
export interface HttpError extends Error {
  statusCode: number;
}

// An error meant for the caller: { statusCode, message } (see middleware/errorHandler.ts for what is passed through).
export function httpError(statusCode: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

/** The message of anything thrown (a `catch` variable is `unknown`). */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** True for an error that already carries an HTTP status (see httpError). */
export const hasStatusCode = (err: unknown): err is HttpError =>
  typeof err === 'object' && err !== null && typeof (err as { statusCode?: unknown }).statusCode === 'number';
