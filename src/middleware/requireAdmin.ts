import type { NextFunction, Request, Response } from 'express';
import { notFound } from './errorHandler';
import { admin } from '../config/env';

// Must run after `authenticate`, which populates req.user from the JWT.
export default function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || (req.user.role !== 'admin' && req.user.email !== admin.email)) {
    // Not an admin: the admin routes simply do not exist for this caller (no 403 in the client contract).
    notFound(req, res);
    return;
  }
  next();
}
