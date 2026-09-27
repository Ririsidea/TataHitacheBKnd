import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Op } from 'sequelize';
import type { NextFunction, Request, Response } from 'express';
import { User } from '../models';
import type { UserInstance } from '../models/User';
import { PAGE_SIZE, parsePageQuery, offsetOf, pageMeta, likeContains } from '../utils/paginate';
import { admin } from '../config/env';
import { validatePassword } from '../utils/passwordPolicy';

const SALT_ROUNDS = 12;

interface PublicEmployee {
  id: number;
  email: string;
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

// Employees, newest first, one page at a time. Optional: q (name or email contains), page.
export async function listEmployees(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parsePageQuery(req.query, ['q']);
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { page } = parsed;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > MAX_SEARCH_LENGTH) {
      res.status(400).json({ success: false, message: `q must be at most ${MAX_SEARCH_LENGTH} characters` });
      return;
    }

    const like = { [Op.like]: likeContains(q) };
    const { rows, count } = await User.findAndCountAll({
      where: q ? { [Op.or]: [{ name: like }, { email: like }] } : {},
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: PAGE_SIZE,
      offset: offsetOf(page),
    });
    res.json({ success: true, data: rows.map(toPublicEmployee), meta: pageMeta({ page, total: count, filters: { q: q || null } }) });
  } catch (err) {
    next(err);
  }
}

export async function addEmployee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, name, phone, password } = (req.body ?? {}) as { email?: unknown; name?: unknown; phone?: unknown; password?: unknown };
    if (!email) {
      res.status(400).json({ success: false, message: 'Email is required' });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      res.status(409).json({ success: false, message: 'An account with that email already exists' });
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
