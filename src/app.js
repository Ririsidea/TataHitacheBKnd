const path = require('path');
const express = require('express');
const cors = require('cors');
const { clientUrl, sap } = require('./config/env');
const healthRoutes = require('./routes/health.routes');
const webhookRoutes = require('./routes/webhook.routes');
const authRoutes = require('./routes/auth.routes');
const mapRoutes = require('./routes/map.routes');
const ordersRoutes = require('./routes/orders.routes');
const dashboardRoutes =require('./routes/dashboard.routes');
const sapRoutes = require('./routes/sap.routes');
const adminRoutes = require('./routes/admin.routes');
const authenticate = require('./middleware/authenticate');
const requireAdmin = require('./middleware/requireAdmin');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'ngrok-skip-browser-warning', 'Accept'],
};

// Express 5 rejects a bare '*' route, and this middleware already answers OPTIONS preflights.
app.use(cors(corsOptions));

// Shopify webhooks are mounted before the JSON body parser: they need the
// raw request body (applied per-route inside webhookRoutes) to verify the
// HMAC signature, and express.json() below would otherwise consume it first.
app.use('/', webhookRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/exports', express.static(path.resolve(sap.localDir)));

app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
// Shopify-related routes authenticate per route with the MAP API key (x-api-key);
// see map.routes.js / orders.routes.js / dashboard.routes.js. JWT stays on auth/sap/admin
// (and the dashboard events feed).
app.use('/api/map', mapRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sap', authenticate, sapRoutes);
app.use('/api/admin', authenticate, requireAdmin, adminRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
