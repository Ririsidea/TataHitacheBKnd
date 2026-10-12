import type { NextFunction, Request, Response } from 'express';
import authenticate from './authenticate';
import { requireApiKey } from './apiKeyAuth';

// Dashboard callers may be the existing MAP API-key client or a signed-in employee using a JWT.
// If an Authorization header is present, it is never silently downgraded to API-key access when
// the token is invalid; that keeps a malformed/expired employee session from changing identity.
export default function requireApiKeyOrJwt(req: Request, res: Response, next: NextFunction): void {
  if (req.get('authorization')) {
    authenticate(req, res, next);
    return;
  }
  requireApiKey(req, res, next);
}
