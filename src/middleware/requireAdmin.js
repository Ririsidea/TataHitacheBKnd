const { admin } = require('../config/env');

// Must run after `authenticate`, which populates req.user from the JWT.
function requireAdmin(req, res, next) {
  if (!admin.email || !req.user || req.user.email !== admin.email) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

module.exports = requireAdmin;
