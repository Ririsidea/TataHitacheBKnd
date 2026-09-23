const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { User } = require('../models');
const { admin } = require('../config/env');
const { validatePassword } = require('../utils/passwordPolicy');

const SALT_ROUNDS = 12;

function toPublicEmployee(user) {
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
function generateTempPassword() {
  const digits = crypto.randomInt(1000, 9999);
  return `Welcome@${digits}`;
}

async function listEmployees(req, res, next) {
  try {
    const users = await User.findAll({ order: [['createdAt', 'DESC']] });
    res.json({ success: true, data: users.map(toPublicEmployee) });
  } catch (err) {
    next(err);
  }
}

async function addEmployee(req, res, next) {
  try {
    const { email, name, phone, password } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'An account with that email already exists' });
    }

    const usingGeneratedPassword = !password;
    const tempPassword = password || generateTempPassword();
    const policyCheck = validatePassword(tempPassword);
    if (!policyCheck.valid) {
      return res.status(400).json({ success: false, message: policyCheck.message });
    }

    const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
    const user = await User.create({
      email: normalizedEmail,
      name: name || null,
      phone: phone || null,
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

async function deleteEmployee(req, res, next) {
  try {
    const { id } = req.params;
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    if (user.email === admin.email) {
      return res.status(400).json({ success: false, message: 'The admin account cannot be deleted' });
    }

    await user.destroy();
    res.json({ success: true, message: 'Employee deleted successfully' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listEmployees, addEmployee, deleteEmployee };
