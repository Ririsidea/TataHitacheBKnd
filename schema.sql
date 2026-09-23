-- Tata-hBackend MySQL schema
-- Import this file directly into phpMyAdmin (or run via `mysql -u root < schema.sql`).
-- Replaces the previous MongoDB/Mongoose data model.

CREATE DATABASE IF NOT EXISTS tata_h_map_shopify
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE tata_h_map_shopify;

-- Note: there is intentionally no `products` table. Product/stock data is never
-- cached locally - the backend reads it live from Shopify's Admin API on every
-- request (see src/services/shopify.js#listProductsCatalog), so Shopify is the
-- only source of truth for the catalogue.

-- ---------------------------------------------------------------------------
-- orders  (was the Order Mongoose model, minus the embedded lineItems array)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shopify_order_id    VARCHAR(255)   NULL,
  employee_name       VARCHAR(255)   NULL,
  employee_email      VARCHAR(255)   NULL,
  employee_phone      VARCHAR(30)    NULL,
  status              VARCHAR(50)    NOT NULL DEFAULT 'open',
  financial_status    VARCHAR(50)    NULL,
  fulfillment_status  VARCHAR(50)    NULL,
  closed_at           DATETIME       NULL,
  total_price         DECIMAL(10,2)  NULL,
  tracking_number     VARCHAR(255)   NULL,
  tracking_url        VARCHAR(1000)  NULL,
  carrier             VARCHAR(255)   NULL,
  created_at          DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- MySQL unique indexes allow multiple NULLs, matching Mongoose's
  -- { unique: true, sparse: true } behaviour on this field.
  UNIQUE KEY uq_orders_shopify_order_id (shopify_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- order_line_items  (was the embedded lineItems[] subdocument array on Order)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_line_items (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id    INT UNSIGNED   NOT NULL,
  sku         VARCHAR(255)   NULL,
  title       VARCHAR(500)   NULL,
  quantity    INT            NULL,
  price       DECIMAL(10,2)  NULL,
  KEY idx_order_line_items_order_id (order_id),
  CONSTRAINT fk_order_line_items_order
    FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- webhook_logs  (was the WebhookLog Mongoose model)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_logs (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  topic        VARCHAR(255) NOT NULL,
  -- payload was Mongoose's Schema.Types.Mixed (arbitrary nested JSON);
  -- MySQL's native JSON column stores and validates it directly.
  payload      JSON         NULL,
  verified     TINYINT(1)   NOT NULL DEFAULT 0,
  received_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_webhook_logs_topic (topic),
  KEY idx_webhook_logs_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- inventory_snapshots  (was the InventorySnapshot Mongoose model)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  inventory_item_id  VARCHAR(255) NOT NULL,
  location_id        VARCHAR(255) NULL,
  available          INT          NULL,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inventory_snapshots_item_location (inventory_item_id, location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- users  (login accounts; the seed script also creates this table automatically)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email                VARCHAR(255)  NOT NULL,
  name                 VARCHAR(255)  NULL,
  phone                VARCHAR(30)   NULL,
  -- bcrypt hash only - a plain-text password column must never exist here.
  password_hash        VARCHAR(255)  NOT NULL,
  must_reset_password  TINYINT(1)    NOT NULL DEFAULT 1,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- daily_exports  (one row per employee per calendar day of exported orders -
-- powers the "Employee Orders" export-history page; the file itself lives on
-- disk under SAP_EXPORT_LOCAL_DIR/daily, this table is just the index of it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_exports (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_email VARCHAR(255)  NOT NULL,
  export_date    DATE          NOT NULL,
  order_count    INT UNSIGNED  NOT NULL DEFAULT 0,
  file_name      VARCHAR(255)  NOT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One export per employee per day - the daily cron skips generating a new
  -- file/row if one already exists for that (employee, date) pair, so a
  -- previous day's export is never regenerated or overwritten.
  UNIQUE KEY uq_daily_exports_employee_date (employee_email, export_date),
  KEY idx_daily_exports_employee (employee_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
