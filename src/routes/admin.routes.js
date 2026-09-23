const express = require('express');
const controller = require('../controllers/admin.controller');

const router = express.Router();

router.get('/employees', controller.listEmployees);
router.post('/employees', controller.addEmployee);
router.delete('/employees/:id', controller.deleteEmployee);

module.exports = router;
