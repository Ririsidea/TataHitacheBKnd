import dotenv from 'dotenv';

dotenv.config();

export const port = Number(process.env.PORT || 5000);
export const nodeEnv = process.env.NODE_ENV || 'development';
export const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';

export const mysql = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tata_h_map_shopify',
};

export const jwtSecret: string | undefined = process.env.JWT_SECRET;

export const admin = {
  email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  name: process.env.ADMIN_NAME || '',
};

// Every value can be missing at runtime (env vars are optional strings) - callers that need one
// treat a missing value as a server misconfiguration (see utils/errors.ts ConfigError).
export const shopify: {
  storeDomain: string | undefined;
  apiVersion: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  accessToken: string | undefined;
  webhookSecret: string | undefined;
} = {
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
  apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecret: process.env.SHOPIFY_API_SECRET,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
};

export const map: { callbackUrl: string | undefined; apiKey: string | undefined } = {
  callbackUrl: process.env.MAP_CALLBACK_URL,
  apiKey: process.env.MAP_API_KEY,
};

// Optional Slack-style incoming webhook for server-side alerts (see services/alert.ts).
export const alert: { webhookUrl: string | undefined } = {
  webhookUrl: process.env.ALERT_WEBHOOK_URL,
};

export const sap = {
  localDir: process.env.SAP_EXPORT_LOCAL_DIR || './exports',
};

export const cloudinary = {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_API_KEY,
  apiSecret: process.env.CLOUDINARY_API_SECRET,
};
