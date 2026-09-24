const express = require('express');
const controller = require('../controllers/orders.controller');
const { requireApiKey } = require('../middleware/apiKeyAuth');

const router = express.Router();

router.put('/:id', requireApiKey, controller.updateOrder);

module.exports = router;
