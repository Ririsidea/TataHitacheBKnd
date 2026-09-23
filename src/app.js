const path = require('path');
const express = require('express');
const cors = require('cors');
const { clientUrl, sap } = require('./config/env');
const healthRoutes = require('./routes/health.routes');
const webhookRoutes = require('./routes/webhook.routes');
const authRoutes = require('./routes/auth.routes');
const mapRoutes = require('./routes/map.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const sapRoutes = require('./routes/sap.routes');
const adminRoutes = require('./routes/admin.routes');
const authenticate = require('./middleware/authenticate');
const requireAdmin = require('./middleware/requireAdmin');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors({ origin: clientUrl }));

// Shopify webhooks are mounted before the JSON body parser: they need the
// raw request body (applied per-route inside webhookRoutes) to verify the
// HMAC signature, and express.json() below would otherwise consume it first.
app.use('/', webhookRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/exports', express.static(path.resolve(sap.localDir)));

app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/map', authenticate, mapRoutes);
app.use('/api/dashboard', authenticate, dashboardRoutes);
app.use('/api/sap', authenticate, sapRoutes);
app.use('/api/admin', authenticate, requireAdmin, adminRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
