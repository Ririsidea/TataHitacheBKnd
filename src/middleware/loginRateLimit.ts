import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

// 10 attempts / 15 min per IP + identifier (email, employee id or ticket id) - a flood
// against one account from many IPs, or many accounts from one IP, is still throttled
// per-pair rather than blocking the whole IP outright (which would also lock out everyone
// behind it, e.g. an office NAT). ipKeyGenerator normalises IPv6 addresses (collapses a /56
// down to one key) so a IPv6 user can't dodge the limit by cycling addresses within their
// own subnet.
//
// The identifier is prefixed with its login type (email / emp / ticket) - employeeId and
// ticketId share the same 5-digit format, so without a prefix the same digits used as one
// user's employeeId and another user's ticketId would wrongly share one rate-limit bucket.
function loginKey(req: Request): string {
  const body = (req.body ?? {}) as { loginType?: unknown; email?: unknown; employeeId?: unknown; ticketId?: unknown; identifier?: unknown };

  // The single-field login sends one value with no declared type (auth.controller.ts
  // resolves email vs employeeId vs ticketId itself, by trying candidates) - the raw
  // value is enough of a bucket key here; it doesn't need that same resolution.
  if (typeof body.identifier === 'string' && body.identifier.trim() !== '') {
    return `${ipKeyGenerator(req.ip || '')}:id:${body.identifier.trim().toLowerCase()}`;
  }

  const hasEmail = typeof body.email === 'string' && body.email.trim() !== '';
  const hasEmployeeId = typeof body.employeeId === 'string' && body.employeeId.trim() !== '';
  const hasTicketId = typeof body.ticketId === 'string' && body.ticketId.trim() !== '';
  const loginType =
    body.loginType === 'email' || body.loginType === 'employeeId' || body.loginType === 'ticketId'
      ? body.loginType
      : hasEmail
        ? 'email'
        : hasEmployeeId
          ? 'employeeId'
          : hasTicketId
            ? 'ticketId'
            : 'email';

  let identifier = '';
  if (loginType === 'email' && typeof body.email === 'string') identifier = `email:${body.email.trim().toLowerCase()}`;
  else if (loginType === 'employeeId' && typeof body.employeeId === 'string') identifier = `emp:${body.employeeId.trim()}`;
  else if (loginType === 'ticketId' && typeof body.ticketId === 'string') identifier = `ticket:${body.ticketId.trim()}`;

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
