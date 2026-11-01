import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

function resetKey(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `${ipKeyGenerator(req.ip || '')}:password-reset:${email}`;
}

const passwordResetRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resetKey,
  message: { success: false, message: 'Too many password reset attempts. Please try again later.' },
});

export default passwordResetRateLimit;
