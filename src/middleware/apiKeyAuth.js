const crypto = require('crypto');
const { map } = require('../config/env');

// The MAP API key (MAP_API_KEY) - sent as the x-api-key header by the third-party MAP system
// and by the web app for the Shopify-related routes. Deliberately separate from the Shopify
// credentials (SHOPIFY_API_KEY / SHOPIFY_ACCESS_TOKEN - used only for outbound calls
// to Shopify) and from JWT_SECRET (used only to sign employee login tokens).
//
// Both values are hashed first so timingSafeEqual always compares equal-length
// buffers, and the comparison time does not depend on how much of the key matched.
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function isValidApiKey(provided) {
  if (!map.apiKey || typeof provided !== 'string' || provided === '') return false;
  return crypto.timingSafeEqual(sha256(provided), sha256(map.apiKey));
}

// Never echo, log or return the provided or configured key from here.
function requireApiKey(req, res, next) {
  if (!map.apiKey) {
    // Fail closed - an unset MAP_API_KEY must never mean "no key required".
    return res.status(503).json({ success: false, message: 'API key authentication is not configured' });
  }

  const provided = req.get('x-api-key');
  if (!provided) {
    return res.status(401).json({ success: false, message: 'API key required' });
  }
  if (!isValidApiKey(provided)) {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }

  req.auth = { type: 'apiKey' };
  next();
}

module.exports = { requireApiKey };
