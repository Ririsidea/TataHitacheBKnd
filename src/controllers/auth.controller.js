const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { jwtSecret, admin } = require('../config/env');
const { validatePassword } = require('../utils/passwordPolicy');

const TOKEN_TTL = '8h';
const SALT_ROUNDS = 12;

function toPublicUser(user) {
  return {
    email: user.email,
    name: user.name,
    phone: user.phone,
    mustResetPassword: user.mustResetPassword,
    // Tells the frontend to show the add/delete-employee option for this account.
    isAdmin: user.email === admin.email,
  };
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await User.findOne({ where: { email: String(email).trim().toLowerCase() } });

    // Same generic message whether the email is unknown or the password is wrong,
    // so a caller can never learn which one was incorrect.
    const genericFailure = () =>
      res.status(401).json({ success: false, message: 'Invalid email or password' });

    if (!user) return genericFailure();

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) return genericFailure();

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
async function resetPassword(req, res, next) {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email and newPassword are required' });
    }

    const policyCheck = validatePassword(newPassword);
    if (!policyCheck.valid) {
      return res.status(400).json({ success: false, message: policyCheck.message });
    }

    const user = await User.findOne({ where: { email: String(email).trim().toLowerCase() } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found for that email' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.mustResetPassword = false;
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findByPk(req.user.userId);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    res.json({ success: true, data: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, resetPassword, me };
