import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { User } from '../models';
import type { UserInstance } from '../models/User';
import { jwtSecret, admin } from '../config/env';
import { ConfigError } from '../utils/errors';
import { validatePassword } from '../utils/passwordPolicy';

const TOKEN_TTL = '8h';
const SALT_ROUNDS = 12;

interface PublicUser {
  email: string;
  name: string | null;
  phone: string | null;
  mustResetPassword: boolean;
  isAdmin: boolean;
}

function toPublicUser(user: UserInstance): PublicUser {
  return {
    email: user.email,
    name: user.name,
    phone: user.phone,
    mustResetPassword: user.mustResetPassword,
    // Tells the frontend to show the add/delete-employee option for this account.
    isAdmin: user.email === admin.email,
  };
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password are required' });
      return;
    }

    const user = await User.findOne({ where: { email: String(email).trim().toLowerCase() } });

    // Same generic message whether the email is unknown or the password is wrong,
    // so a caller can never learn which one was incorrect.
    const genericFailure = (): void => {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
    };

    if (!user) {
      genericFailure();
      return;
    }

    const matches = await bcrypt.compare(String(password), user.passwordHash);
    if (!matches) {
      genericFailure();
      return;
    }

    if (!jwtSecret) throw new ConfigError('JWT_SECRET is not set');
    const token = jwt.sign({ userId: user.id, email: user.email }, jwtSecret, { expiresIn: TOKEN_TTL });

    res.json({ success: true, data: { token, user: toPublicUser(user) } });
  } catch (err) {
    next(err);
  }
}

// Demo-only reset: proving control of the email inbox (e.g. via a one-time code) is
// out of scope for this project, so knowing the email address alone is enough to
// reset it here. A production version MUST verify identity first - either a one-time
// code sent to the email for a "forgot password" flow, or the current password for a
// logged-in "change password" action - before ever accepting a bare email + new password.
export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, newPassword } = (req.body ?? {}) as { email?: unknown; newPassword?: unknown };
    if (!email || !newPassword) {
      res.status(400).json({ success: false, message: 'Email and newPassword are required' });
      return;
    }

    const policyCheck = validatePassword(newPassword);
    if (!policyCheck.valid) {
      res.status(400).json({ success: false, message: policyCheck.message });
      return;
    }

    const user = await User.findOne({ where: { email: String(email).trim().toLowerCase() } });
    if (!user) {
      res.status(404).json({ success: false, message: 'No account found for that email' });
      return;
    }

    user.passwordHash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
    user.mustResetPassword = false;
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await User.findByPk(req.user?.userId);
    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }
    res.json({ success: true, data: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}
