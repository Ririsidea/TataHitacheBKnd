const crypto = require('crypto');
const { shopify } = require('../config/env');
const WebhookLog = require('../models/WebhookLog');

// Requires express.raw({ type: 'application/json' }) to run first on this
// route so req.body is the untouched raw Buffer Shopify signed.
async function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-SHA256');
  const rawBody = req.body;

  if (!hmacHeader || !Buffer.isBuffer(rawBody)) {
    return res.status(401).json({ success: false, message: 'Missing HMAC signature' });
  }

  const digest = crypto
    .createHmac('sha256', shopify.webhookSecret)
    .update(rawBody)
    .digest('base64');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmacHeader, 'utf8');

  const isValid =
    digestBuffer.length === hmacBuffer.length && crypto.timingSafeEqual(digestBuffer, hmacBuffer);

  if (!isValid) {
    await WebhookLog.create({
      topic: req.get('X-Shopify-Topic') || req.path,
      payload: { note: 'Signature verification failed' },
      verified: false,
      receivedAt: new Date(),
    }).catch((err) => console.error('Failed to log invalid webhook:', err.message));

    return res.status(401).json({ success: false, message: 'Invalid HMAC signature' });
  }

  try {
    req.shopifyPayload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ success: false, message: 'Invalid JSON payload' });
  }

  next();
}

module.exports = verifyShopifyWebhook;
