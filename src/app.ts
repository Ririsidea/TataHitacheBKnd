import path from 'path';
import express from 'express';
import cors from 'cors';
import { sap } from './config/env';
import webhookRoutes from './routes/webhook.routes';
import authRoutes from './routes/auth.routes';
import mapRoutes from './routes/map.routes';
import dashboardRoutes from './routes/dashboard.routes';
import sapRoutes from './routes/sap.routes';
import adminRoutes from './routes/admin.routes';
import authenticate from './middleware/authenticate';
import requireAdmin from './middleware/requireAdmin';
import { notFound, errorHandler } from './middleware/errorHandler';
import requestId from './middleware/requestId';

const app = express();

const corsOptions: cors.CorsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-request-id', 'ngrok-skip-browser-warning', 'Accept'],
  exposedHeaders: ['X-Request-Id'],
};

// Every request gets a requestId first (also CORS preflights and webhooks), so every error can be traced.
app.use(requestId);

// Express 5 rejects a bare '*' route, and this middleware already answers OPTIONS preflights.
app.use(cors(corsOptions));

// Shopify webhooks are mounted before the JSON body parser: they need the
// raw request body (applied per-route inside webhookRoutes) to verify the
// HMAC signature, and express.json() below would otherwise consume it first.
app.use('/', webhookRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/exports', express.static(path.resolve(sap.localDir)));

app.get('/api/health', (_req, res) => {
  res.json({ success: true, message: 'Server is healthy', timestamp: new Date().toISOString() });
});
app.use('/api/auth', authRoutes);
// Shopify-related routes authenticate per route with the MAP API key (x-api-key);
// see map.routes.ts / dashboard.routes.ts. JWT stays on auth/sap/admin
// (and the dashboard events feed).
app.use('/api/map', mapRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sap', authenticate, sapRoutes);
app.use('/api/admin', authenticate, requireAdmin, adminRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
