import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { jwtSecret, admin } from '../config/env';
import { ConfigError } from '../utils/errors';
import { User } from '../models';
import type { JwtPayload } from '../controllers/auth.controller';

export default async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!jwtSecret) {
    next(new ConfigError('JWT_SECRET is not set'));
    return;
  }
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload & JwtPayload;

    // Sessions end when the JWT expires (8h, checked by jwt.verify above); there is no
    // server-side revocation. Re-reading the user row here only catches a deleted account -
    // a 401 the moment its JWT is next used, rather than waiting for the token to expire.
    const user = await User.findByPk(decoded.userId);
    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }

    // Role is read from the current database row on every request, so changing an
    // account's role takes effect without waiting for an existing JWT to expire.
    // The email fallback only supports legacy test/seed rows that predate users.role;
    // persisted users always have the non-null role column.
    const role = user.role ?? (user.email === admin.email ? 'admin' : 'employee');
    req.user = { userId: user.id, email: user.email, role };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
