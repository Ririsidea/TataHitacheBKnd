import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { jwtSecret } from '../config/env';
import { ConfigError } from '../utils/errors';

export default function authenticate(req: Request, res: Response, next: NextFunction): void {
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
    req.user = { userId: decoded.userId as number, email: decoded.email as string };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
