import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { shopify } from '../config/env';
import WebhookLog from '../models/WebhookLog';
import { ConfigError } from '../utils/errors';

// Requires express.raw({ type: 'application/json' }) to run first on this
// route so req.body is the untouched raw Buffer Shopify signed.
export default async function verifyShopifyWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!shopify.webhookSecret) {
    next(new ConfigError('SHOPIFY_WEBHOOK_SECRET is not set'));
    return;
  }
  const hmacHeader = req.get('X-Shopify-Hmac-SHA256');
  const rawBody: unknown = req.body;

  if (!hmacHeader || !Buffer.isBuffer(rawBody)) {
    res.status(401).json({ success: false, message: 'Missing HMAC signature' });
    return;
  }

  const digest = crypto.createHmac('sha256', shopify.webhookSecret).update(rawBody).digest('base64');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmacHeader, 'utf8');

  const isValid = digestBuffer.length === hmacBuffer.length && crypto.timingSafeEqual(digestBuffer, hmacBuffer);

  if (!isValid) {
    await WebhookLog.create({
      topic: req.get('X-Shopify-Topic') || req.path,
      payload: { note: 'Signature verification failed' },
      verified: false,
      receivedAt: new Date(),
    }).catch((err: Error) => console.error('Failed to log invalid webhook:', err.message));

    res.status(401).json({ success: false, message: 'Invalid HMAC signature' });
    return;
  }

  try {
    req.shopifyPayload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ success: false, message: 'Invalid JSON payload' });
    return;
  }

  next();
}
