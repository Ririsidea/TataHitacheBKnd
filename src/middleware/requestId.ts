import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { CLIENT_STATUSES, GENERIC_MESSAGE } from '../utils/errors';

// A caller-supplied X-Request-Id is kept when it looks like an id (so a caller can correlate its own
// logs); otherwise a new one is made. It is sent back as the X-Request-Id header and, on every
// error response, as `requestId` in the body - support finds the matching log lines with it.
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

export default function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('x-request-id');
  req.id = inbound && VALID_ID.test(inbound) ? inbound : crypto.randomUUID();
  res.set('X-Request-Id', req.id);

  // Every JSON error body, from any handler or middleware, goes through here: it gets the
  // requestId, and a status outside the client contract can never leave the server.
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      let out = body as { message?: string; [key: string]: unknown };
      if (!CLIENT_STATUSES.has(res.statusCode)) {
        console.error(`[${req.id}] ${req.method} ${req.originalUrl} tried to answer ${res.statusCode} - sent 500 instead`);
        res.status(500);
        out = { success: false, message: GENERIC_MESSAGE };
      }
      if (!res.locals.errorLogged) {
        console.warn(`[${req.id}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${out.message || ''}`);
      }
      return json({ ...out, requestId: req.id });
    }
    return json(body);
  };
  next();
}
