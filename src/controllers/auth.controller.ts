import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import type { NextFunction, Request, Response } from 'express';
import { User } from '../models';
import type { UserInstance } from '../models/User';
import { jwtSecret, admin } from '../config/env';
import { ConfigError } from '../utils/errors';
import { validatePassword } from '../utils/passwordPolicy';
import { isValidEmployeeId } from '../utils/employeeId';
import { isValidTicketId } from '../utils/ticketId';

const TOKEN_TTL = '8h';
const SALT_ROUNDS = 12;

// The only claims a JWT carries. Sessions end when the token expires (8h); there is no
// server-side revocation, so a deleted account is caught by middleware/authenticate.ts
// re-reading the user row on every request, not by anything inside the token itself.
export interface JwtPayload {
  userId: number;
  email: string;
}

interface PublicUser {
  email: string;
  employeeId: string;
  ticketId: string | null;
  name: string | null;
  phone: string | null;
  mustResetPassword: boolean;
  isAdmin: boolean;
}

function toPublicUser(user: UserInstance): PublicUser {
  return {
    email: user.email,
    employeeId: user.employeeId,
    ticketId: user.ticketId,
    name: user.name,
    phone: user.phone,
    mustResetPassword: user.mustResetPassword,
    // Tells the frontend to show the add/delete-employee option for this account.
    isAdmin: user.email === admin.email,
  };
}

const IDENTIFIER_IS_EMAIL = /@/;
const IDENTIFIER_IS_FIVE_DIGITS = /^\d{5}$/;

// The single-field login (current frontend): one box, whatever the person typed.
//   @ in it            -> looked up as email
//   exactly 5 digits   -> looked up against BOTH employeeId and ticketId (they're never
//                         cross-checked elsewhere, so the same 5 digits can legitimately
//                         belong to one user's employeeId and a different user's
//                         ticketId; see models/User.ts). Whichever candidate the given
//                         password actually matches is who logs in - the password is
//                         what disambiguates, not an extra "which kind of ID is this"
//                         question in the UI.
//   anything else      -> 400, nothing to look up
async function loginByIdentifier(rawIdentifier: string, rawPassword: unknown, res: Response, next: NextFunction): Promise<void> {
  try {
    const identifier = rawIdentifier.trim();
    if (!identifier || !rawPassword) {
      res.status(400).json({ success: false, message: 'Email, employee ID or ticket ID and password are required' });
      return;
    }

    const genericFailure = (): void => {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    };

    let candidates: UserInstance[];
    if (IDENTIFIER_IS_EMAIL.test(identifier)) {
      const user = await User.findOne({ where: { email: identifier.toLowerCase() } });
      candidates = user ? [user] : [];
    } else if (IDENTIFIER_IS_FIVE_DIGITS.test(identifier)) {
      candidates = await User.findAll({ where: { [Op.or]: [{ employeeId: identifier }, { ticketId: identifier }] } });
    } else {
      res.status(400).json({ success: false, message: 'Enter your email, employee ID or ticket ID' });
      return;
    }

    if (!candidates.length) {
      genericFailure();
      return;
    }

    let matched: UserInstance | null = null;
    for (const candidate of candidates) {
      if (await bcrypt.compare(String(rawPassword), candidate.passwordHash)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) {
      genericFailure();
      return;
    }

    if (!jwtSecret) throw new ConfigError('JWT_SECRET is not set');
    const payload: JwtPayload = { userId: matched.id, email: matched.email };
    const token = jwt.sign(payload, jwtSecret, { expiresIn: TOKEN_TTL });
    res.json({ success: true, data: { token, user: toPublicUser(matched) } });
  } catch (err) {
    next(err);
  }
}

// Accepts:
//   { identifier, password }   (current frontend - one field, auto-detected, see above)
//   { loginType: 'email', email, password }
//   { loginType: 'employeeId', employeeId, password }
//   { loginType: 'ticketId', ticketId, password }
//   { email, password }        (no loginType - old clients - treated as email)
//   { employeeId, password }   (no loginType, no email - treated as employeeId)
//   { ticketId, password }     (no loginType, no email, no employeeId - treated as ticketId)
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as { loginType?: unknown; email?: unknown; employeeId?: unknown; ticketId?: unknown; identifier?: unknown; password?: unknown };

    if (typeof body.identifier === 'string') {
      await loginByIdentifier(body.identifier, body.password, res, next);
      return;
    }

    if (body.loginType !== undefined && body.loginType !== 'email' && body.loginType !== 'employeeId' && body.loginType !== 'ticketId') {
      res.status(400).json({ success: false, message: 'loginType must be email, employeeId or ticketId' });
      return;
    }

    const hasEmail = typeof body.email === 'string' && body.email.trim() !== '';
    const hasEmployeeId = typeof body.employeeId === 'string' && body.employeeId.trim() !== '';
    const hasTicketId = typeof body.ticketId === 'string' && body.ticketId.trim() !== '';
    const loginType: 'email' | 'employeeId' | 'ticketId' =
      body.loginType === 'email' || body.loginType === 'employeeId' || body.loginType === 'ticketId'
        ? body.loginType
        : hasEmail
          ? 'email'
          : hasEmployeeId
            ? 'employeeId'
            : hasTicketId
              ? 'ticketId'
              : 'email';

    // Same generic message for every kind of failure past this point - unknown
    // identifier or wrong password - so a caller never learns which one was wrong.
    const genericFailure = (): void => {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    };

    // loginType alone decides which column is queried - employeeId and ticketId share the
    // same 5-digit format, so there is no other way to tell them apart, and a value is
    // never looked up against the other column as a fallback.
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
    } else if (loginType === 'ticketId') {
      const ticketId = typeof body.ticketId === 'string' ? body.ticketId.trim() : '';
      if (!ticketId || !body.password) {
        res.status(400).json({ success: false, message: 'Ticket ID and password are required' });
        return;
      }
      if (!isValidTicketId(ticketId)) {
        res.status(400).json({ success: false, message: 'ticketId must be exactly 5 digits' });
        return;
      }
      user = await User.findOne({ where: { ticketId } });
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
    const payload: JwtPayload = { userId: user.id, email: user.email };
    const token = jwt.sign(payload, jwtSecret, { expiresIn: TOKEN_TTL });

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
