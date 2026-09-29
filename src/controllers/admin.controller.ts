import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Op } from 'sequelize';
import type { NextFunction, Request, Response } from 'express';
import { User } from '../models';
import type { UserInstance } from '../models/User';
import { sequelize } from '../config/db';
import { parseCursorQuery, pageInfo, likeContains } from '../utils/paginate';
import { admin } from '../config/env';
import { validatePassword } from '../utils/passwordPolicy';
import { isValidEmployeeId } from '../utils/employeeId';

const SALT_ROUNDS = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PublicEmployee {
  id: number;
  email: string;
  employeeId: string;
  name: string | null;
  phone: string | null;
  mustResetPassword: boolean;
  isAdmin: boolean;
  createdAt: Date;
}

function toPublicEmployee(user: UserInstance): PublicEmployee {
  return {
    id: user.id,
    email: user.email,
    employeeId: user.employeeId,
    name: user.name,
    phone: user.phone,
    mustResetPassword: user.mustResetPassword,
    isAdmin: user.email === admin.email,
    createdAt: user.createdAt,
  };
}

// Always satisfies passwordPolicy (letter + number + special char, 7+ chars);
// shown once to the admin since only the bcrypt hash is ever persisted.
function generateTempPassword(): string {
  const digits = crypto.randomInt(1000, 9999);
  return `Welcome@${digits}`;
}

const MAX_SEARCH_LENGTH = 100;

// Employees, newest first, one cursor page at a time. Optional: q (name or email contains),
// limit, after, before.
export async function listEmployees(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parseCursorQuery(req.query, ['q']);
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { limit, offset } = parsed;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > MAX_SEARCH_LENGTH) {
      res.status(400).json({ success: false, message: `q must be at most ${MAX_SEARCH_LENGTH} characters` });
      return;
    }

    const like = { [Op.like]: likeContains(q) };
    const { rows, count } = await User.findAndCountAll({
      where: q ? { [Op.or]: [{ name: like }, { email: like }, { employeeId: like }] } : {},
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset,
    });
    res.json({
      success: true,
      data: rows.map(toPublicEmployee),
      pageInfo: pageInfo({ limit, offset, total: count, filters: { q: q || null } }),
    });
  } catch (err) {
    next(err);
  }
}

export async function addEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, employeeId, name, phone, password } = (req.body ?? {}) as {
      email?: unknown;
      employeeId?: unknown;
      name?: unknown;
      phone?: unknown;
      password?: unknown;
    };
    if (!email) {
      res.status(400).json({ success: false, message: 'Email is required' });
      return;
    }
    const trimmedEmployeeId = typeof employeeId === 'string' ? employeeId.trim() : '';
    if (!isValidEmployeeId(trimmedEmployeeId)) {
      res.status(400).json({ success: false, message: 'employeeId must be exactly 5 digits' });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existingEmail = await User.findOne({ where: { email: normalizedEmail } });
    if (existingEmail) {
      res.status(409).json({ success: false, message: 'An account with that email already exists' });
      return;
    }
    const existingEmployeeId = await User.findOne({ where: { employeeId: trimmedEmployeeId } });
    if (existingEmployeeId) {
      res.status(409).json({ success: false, message: 'An account with that employee ID already exists' });
      return;
    }

    const usingGeneratedPassword = !password;
    const tempPassword = password ? String(password) : generateTempPassword();
    const policyCheck = validatePassword(tempPassword);
    if (!policyCheck.valid) {
      res.status(400).json({ success: false, message: policyCheck.message });
      return;
    }

    const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
    const user = await User.create({
      email: normalizedEmail,
      employeeId: trimmedEmployeeId,
      name: name ? String(name) : null,
      phone: phone ? String(phone) : null,
      passwordHash,
      mustResetPassword: true,
    });

    res.status(201).json({
      success: true,
      message: 'Employee added successfully',
      data: {
        employee: toPublicEmployee(user),
        temporaryPassword: usingGeneratedPassword ? tempPassword : undefined,
      },
    });
  } catch (err) {
    next(err);
  }
}

type UpdateOutcome =
  | { kind: 'notFound' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'ok'; user: UserInstance; passwordChanged: boolean };

// Admin can change name, email, employeeId, phone and (optionally) set a new password - all in
// one call, one transaction: if any field fails validation, nothing is written. Same format +
// uniqueness rules as addEmployee for email/employeeId, except uniqueness checks ignore this
// user's own row. newPassword is optional; missing or blank leaves the current password as-is.
export async function updateEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = String(req.params.id);
    const { email, employeeId, name, phone, newPassword } = (req.body ?? {}) as {
      email?: unknown;
      employeeId?: unknown;
      name?: unknown;
      phone?: unknown;
      newPassword?: unknown;
    };

    const outcome = await sequelize.transaction<UpdateOutcome>(async (transaction) => {
      const user = await User.findByPk(id, { transaction });
      if (!user) return { kind: 'notFound' };

      if (email !== undefined) {
        const normalizedEmail = String(email).trim().toLowerCase();
        if (!normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
          return { kind: 'error', status: 400, message: 'email must be a valid email address' };
        }
        // The admin's own account is identified purely by matching config.admin.email - changing
        // it away here would silently strip this account of admin rights (and req.user, already
        // issued for the old email, would still work for the rest of this request).
        if (user.email === admin.email && normalizedEmail !== admin.email) {
          return { kind: 'error', status: 400, message: 'The admin account cannot change its own email' };
        }
        if (normalizedEmail !== user.email) {
          const existing = await User.findOne({ where: { email: normalizedEmail, id: { [Op.ne]: user.id } }, transaction });
          if (existing) return { kind: 'error', status: 409, message: 'An account with that email already exists' };
        }
        user.email = normalizedEmail;
      }

      if (employeeId !== undefined) {
        const trimmedEmployeeId = typeof employeeId === 'string' ? employeeId.trim() : '';
        if (!isValidEmployeeId(trimmedEmployeeId)) {
          return { kind: 'error', status: 400, message: 'employeeId must be exactly 5 digits' };
        }
        if (trimmedEmployeeId !== user.employeeId) {
          const existing = await User.findOne({ where: { employeeId: trimmedEmployeeId, id: { [Op.ne]: user.id } }, transaction });
          if (existing) return { kind: 'error', status: 409, message: 'An account with that employee ID already exists' };
        }
        user.employeeId = trimmedEmployeeId;
      }

      if (name !== undefined) user.name = name ? String(name) : null;
      if (phone !== undefined) user.phone = phone ? String(phone) : null;

      // Admin-set password: hashed, never logged or returned. mustResetPassword is forced back
      // to true so the employee chooses their own password on next login rather than keeping
      // one the admin has seen. tokenVersion is bumped so any JWT issued before this reset is
      // rejected by middleware/authenticate.ts on its next request, even though it hasn't expired yet.
      let passwordChanged = false;
      if (typeof newPassword === 'string' && newPassword.trim() !== '') {
        const policyCheck = validatePassword(newPassword);
        if (!policyCheck.valid) {
          return { kind: 'error', status: 400, message: policyCheck.message };
        }
        user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        user.mustResetPassword = true;
        user.tokenVersion += 1;
        passwordChanged = true;
      }

      await user.save({ transaction });
      return { kind: 'ok', user, passwordChanged };
    });

    if (outcome.kind === 'notFound') {
      res.status(404).json({ success: false, message: 'Employee not found' });
      return;
    }
    if (outcome.kind === 'error') {
      res.status(outcome.status).json({ success: false, message: outcome.message });
      return;
    }
    res.json({
      success: true,
      message: 'Employee updated successfully',
      data: toPublicEmployee(outcome.user),
      passwordChanged: outcome.passwordChanged,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = String(req.params.id);
    const user = await User.findByPk(id);
    if (!user) {
      res.status(404).json({ success: false, message: 'Employee not found' });
      return;
    }

    if (user.email === admin.email) {
      res.status(400).json({ success: false, message: 'The admin account cannot be deleted' });
      return;
    }

    await user.destroy();
    res.json({ success: true, message: 'Employee deleted successfully' });
  } catch (err) {
    next(err);
  }
}
