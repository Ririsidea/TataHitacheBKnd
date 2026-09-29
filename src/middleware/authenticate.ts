import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { jwtSecret } from '../config/env';
import { ConfigError } from '../utils/errors';
import { User } from '../models';

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
    const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload;
    const userId = decoded.userId as number;

    // tokenVersion is bumped whenever an admin resets this user's password
    // (admin.controller.ts updateEmployee, when newPassword is sent), so a token signed
    // before that reset is rejected here even though its signature and expiry are still valid.
    const user = await User.findByPk(userId);
    if (!user || user.tokenVersion !== ((decoded.tokenVersion as number | undefined) ?? 0)) {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }

    req.user = { userId, email: decoded.email as string };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
