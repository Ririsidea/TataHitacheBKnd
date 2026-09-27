import type { NextFunction, Request, Response } from 'express';
import { GENERIC_MESSAGE, UNAVAILABLE_MESSAGE, PASS_THROUGH_STATUSES, ConfigError } from '../utils/errors';
import * as alert from '../services/alert';

export const notFound = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.originalUrl}`,
  });
};

export interface Classified {
  status: number;
  message: string;
  alertTitle?: string;
}

// An error object as it can arrive here: our own httpError, an axios error, a body-parser error...
interface ErrorLike {
  message?: string;
  statusCode?: number;
  status?: number;
  type?: string;
  expose?: boolean;
  isAxiosError?: boolean;
  response?: { status?: number };
  stack?: string;
}

// Turns anything thrown into the client-facing contract: { success:false, message, requestId }
// with a status from utils/errors.ts CLIENT_STATUSES (the requestId is added in middleware/requestId.ts).
//   - 400 / 401 / 404 / 409 / 429 raised on purpose keep their own message.
//   - Shopify unreachable or erroring (or throttling us) -> 502 "Service temporarily unavailable, please retry".
//   - Everything else - misconfiguration, a rejected Shopify credential, database errors, bugs -> 500 with a
//     generic message. The real cause is logged with the requestId and alerted, never sent to the caller.
export function classify(thrown: unknown): Classified {
  if (thrown instanceof ConfigError) {
    return { status: 500, message: GENERIC_MESSAGE, alertTitle: `Server misconfiguration: ${thrown.message}` };
  }
  const err = (thrown && typeof thrown === 'object' ? thrown : { message: String(thrown) }) as ErrorLike;

  if (err.type === 'entity.parse.failed') return { status: 400, message: 'Invalid JSON body' };
  if (err.type === 'entity.too.large') return { status: 400, message: 'Request body is too large' };

  if (err.isAxiosError) {
    const upstream = err.response?.status;
    if (!err.response || (upstream !== undefined && (upstream >= 500 || upstream === 429))) {
      return { status: 502, message: UNAVAILABLE_MESSAGE };
    }
    if (upstream === 401 || upstream === 403) {
      return { status: 500, message: GENERIC_MESSAGE, alertTitle: `Shopify rejected the backend credentials (${upstream})` };
    }
    return { status: 500, message: GENERIC_MESSAGE, alertTitle: `Unexpected Shopify response (${upstream})` };
  }

  const code = err.statusCode ?? err.status;
  if (code !== undefined && PASS_THROUGH_STATUSES.has(code)) return { status: code, message: err.message ?? '' };
  if (code === 502) return { status: 502, message: UNAVAILABLE_MESSAGE };
  // A 4xx from a library (unsupported media type, ...) says so with `expose` - still the caller's request being wrong.
  // A 4xx raised by our own code outside the contract (403, 410, ...) is a bug, so it falls through to the 500.
  if (code !== undefined && code >= 400 && code < 500 && err.expose) return { status: 400, message: 'Invalid request' };
  return { status: 500, message: GENERIC_MESSAGE, alertTitle: `Unexpected error: ${err.message || String(thrown)}` };
}

export const errorHandler = (thrown: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    next(thrown);
    return;
  }
  const { status, message, alertTitle } = classify(thrown);
  const err = (thrown && typeof thrown === 'object' ? thrown : {}) as ErrorLike;

  res.locals.errorLogged = true;
  console[status >= 500 ? 'error' : 'warn'](`[${req.id}] ${req.method} ${req.originalUrl} -> ${status}`, status >= 500 ? err.stack || thrown : err.message);
  if (status === 500) {
    void alert.alertServerError({
      key: alertTitle || 'unexpected',
      title: alertTitle || `Unexpected error: ${err.message || String(thrown)}`,
      requestId: req.id,
      detail: `${req.method} ${req.originalUrl}`,
    });
  }

  res.status(status).json({ success: false, message });
};
