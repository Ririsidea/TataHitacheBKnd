import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

// 10 attempts / 15 min per IP + identifier (email or employee id) - a flood against one
// account from many IPs, or many accounts from one IP, is still throttled per-pair rather
// than blocking the whole IP outright (which would also lock out everyone behind it, e.g.
// an office NAT). ipKeyGenerator normalises IPv6 addresses (collapses a /56 down to one key)
// so a IPv6 user can't dodge the limit by cycling addresses within their own subnet.
function loginKey(req: Request): string {
  const body = (req.body ?? {}) as { email?: unknown; employeeId?: unknown };
  const identifier = typeof body.email === 'string' ? body.email.trim().toLowerCase() : typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
  return `${ipKeyGenerator(req.ip || '')}:${identifier}`;
}

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: loginKey,
  message: { success: false, message: 'Too many login attempts. Please try again later.' },
});

export default loginRateLimit;
