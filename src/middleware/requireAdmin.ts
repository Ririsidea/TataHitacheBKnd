import type { NextFunction, Request, Response } from 'express';
import { admin } from '../config/env';
import { notFound } from './errorHandler';

// Must run after `authenticate`, which populates req.user from the JWT.
export default function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!admin.email || !req.user || req.user.email !== admin.email) {
    // Not an admin: the admin routes simply do not exist for this caller (no 403 in the client contract).
    notFound(req, res);
    return;
  }
  next();
}
