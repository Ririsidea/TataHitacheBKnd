const express = require('express');
const controller = require('../controllers/auth.controller');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

router.post('/login', controller.login);
router.post('/reset-password', controller.resetPassword);
router.get('/me', authenticate, controller.me);

module.exports = router;
