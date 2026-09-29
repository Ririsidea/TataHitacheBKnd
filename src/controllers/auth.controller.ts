import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { User } from '../models';
import type { UserInstance } from '../models/User';
import { jwtSecret, admin } from '../config/env';
import { ConfigError } from '../utils/errors';
import { validatePassword } from '../utils/passwordPolicy';
import { isValidEmployeeId } from '../utils/employeeId';

const TOKEN_TTL = '8h';
const SALT_ROUNDS = 12;

interface PublicUser {
  email: string;
  employeeId: string;
  name: string | null;
  phone: string | null;
  mustResetPassword: boolean;
  isAdmin: boolean;
}

function toPublicUser(user: UserInstance): PublicUser {
  return {
    email: user.email,
    employeeId: user.employeeId,
    name: user.name,
    phone: user.phone,
    mustResetPassword: user.mustResetPassword,
    // Tells the frontend to show the add/delete-employee option for this account.
    isAdmin: user.email === admin.email,
  };
}

// Accepts:
//   { loginType: 'email', email, password }
//   { loginType: 'employeeId', employeeId, password }
//   { email, password }        (no loginType - old clients - treated as email)
//   { employeeId, password }   (no loginType, no email - treated as employeeId)
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as { loginType?: unknown; email?: unknown; employeeId?: unknown; password?: unknown };

    if (body.loginType !== undefined && body.loginType !== 'email' && body.loginType !== 'employeeId') {
      res.status(400).json({ success: false, message: 'loginType must be email or employeeId' });
      return;
    }

    const hasEmail = typeof body.email === 'string' && body.email.trim() !== '';
    const hasEmployeeId = typeof body.employeeId === 'string' && body.employeeId.trim() !== '';
    const loginType: 'email' | 'employeeId' =
      body.loginType === 'email' || body.loginType === 'employeeId' ? body.loginType : hasEmail ? 'email' : hasEmployeeId ? 'employeeId' : 'email';

    // Same generic message for every kind of failure past this point - unknown
    // identifier or wrong password - so a caller never learns which one was wrong.
    const genericFailure = (): void => {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    };

    let user: UserInstance | null;
    if (loginType === 'employeeId') {
      const employeeId = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
      if (!employeeId || !body.password) {
        res.status(400).json({ success: false, message: 'Employee ID and password are required' });
        return;
      }
      if (!isValidEmployeeId(employeeId)) {
        res.status(400).json({ success: false, message: 'employeeId must be exactly 5 digits' });
        return;
      }
      user = await User.findOne({ where: { employeeId } });
    } else {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!email || !body.password) {
        res.status(400).json({ success: false, message: 'Email and password are required' });
        return;
      }
      user = await User.findOne({ where: { email } });
    }

    if (!user) {
      genericFailure();
      return;
    }

    const matches = await bcrypt.compare(String(body.password), user.passwordHash);
    if (!matches) {
      genericFailure();
      return;
    }

    if (!jwtSecret) throw new ConfigError('JWT_SECRET is not set');
    const token = jwt.sign({ userId: user.id, email: user.email, tokenVersion: user.tokenVersion }, jwtSecret, { expiresIn: TOKEN_TTL });

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
