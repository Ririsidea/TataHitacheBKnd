require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  mysql: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tata_h_map_shopify',
  },
  jwtSecret: process.env.JWT_SECRET,
  admin: {
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    name: process.env.ADMIN_NAME || '',
  },
  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
  },
  map: {
    callbackUrl: process.env.MAP_CALLBACK_URL,
    apiKey: process.env.MAP_API_KEY,
  },
  sap: {
    exportMode: process.env.SAP_EXPORT_MODE || 'local',
    localDir: process.env.SAP_EXPORT_LOCAL_DIR || './exports',
  },
};
