import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { map } from '../config/env';
import { ConfigError } from '../utils/errors';

// The MAP API key (MAP_API_KEY) - sent as the x-api-key header by the third-party MAP system
// and by the web app for the Shopify-related routes. Deliberately separate from the Shopify
// credentials (SHOPIFY_API_KEY / SHOPIFY_ACCESS_TOKEN - used only for outbound calls
// to Shopify) and from JWT_SECRET (used only to sign employee login tokens).
//
// Both values are hashed first so timingSafeEqual always compares equal-length
// buffers, and the comparison time does not depend on how much of the key matched.
function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function isValidApiKey(provided: unknown): boolean {
  if (!map.apiKey || typeof provided !== 'string' || provided === '') return false;
  return crypto.timingSafeEqual(sha256(provided), sha256(map.apiKey));
}

// Never echo, log or return the provided or configured key from here.
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!map.apiKey) {
    // Fail closed - an unset MAP_API_KEY must never mean "no key required". The caller gets a generic
    // 500 (it cannot fix this); the reason is logged and alerted.
    next(new ConfigError('MAP_API_KEY is not set'));
    return;
  }

  const provided = req.get('x-api-key');
  if (!provided) {
    res.status(401).json({ success: false, message: 'API key required' });
    return;
  }
  if (!isValidApiKey(provided)) {
    res.status(401).json({ success: false, message: 'Invalid API key' });
    return;
  }

  req.auth = { type: 'apiKey' };
  next();
}
