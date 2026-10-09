import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';
import type { OrderLineItemInstance } from './OrderLineItem';

export interface OrderAttributes {
  id: number;
  shopifyOrderId: string | null;
  // The employee the order was placed for. The columns keep their employee_* names; the API
  // (and this model) call them name / email / phone.
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  deliveryStatus: string | null;
  closedAt: Date | null;
  // DECIMAL columns come back from MySQL as strings.
  totalPrice: string | number | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  channel: string | null;
  // Everything below is order detail for the export sheet (see services/orderDetails.ts), read
  // ONLY from the raw webhook payload - never from a live Shopify read, which this store's app
  // gets back with address/customer PII redacted. A field Shopify never sent stays NULL; it is
  // never invented. orders.raw_payload is NOT exposed here (see ensureSchema.ts) - it is backend-only.
  orderNumber: string | null;
  shippingName: string | null;
  shippingAddress1: string | null;
  shippingAddress2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingZip: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
  billingName: string | null;
  billingAddress1: string | null;
  billingAddress2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string | null;
  billingPhone: string | null;
  // Shopify's own order/customer email+phone - distinct from `email`/`phone` above, which are
  // the EMPLOYEE's identity (set by create-order, or left NULL for a webhook-only row).
  customerEmail: string | null;
  customerPhone: string | null;
  subtotalPrice: string | number | null;
  totalDiscount: string | number | null;
  totalTax: string | number | null;
  shippingCharge: string | number | null;
  paymentMethod: string | null;
  orderNote: string | null;
  tags: string | null;
  cancelReason: string | null;
  cancelledAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderCreationAttributes = Partial<OrderAttributes>;

// An order row; `lineItems` is present when it was loaded with include: [{ as: 'lineItems' }].
export interface OrderInstance extends Model<OrderAttributes, OrderCreationAttributes>, OrderAttributes {
  lineItems?: OrderLineItemInstance[];
}

const Order = sequelize.define<OrderInstance>(
  'Order',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    shopifyOrderId: { type: DataTypes.STRING(255), unique: true, field: 'shopify_order_id' },
    name: { type: DataTypes.STRING(255), field: 'employee_name' },
    email: { type: DataTypes.STRING(255), field: 'employee_email' },
    phone: { type: DataTypes.STRING(30), field: 'employee_phone' },
    status: { type: DataTypes.STRING(50), defaultValue: 'open' },
    financialStatus: { type: DataTypes.STRING(50), field: 'financial_status' },
    fulfillmentStatus: { type: DataTypes.STRING(50), field: 'fulfillment_status' },
    deliveryStatus: { type: DataTypes.STRING(50), field: 'delivery_status' },
    closedAt: { type: DataTypes.DATE, field: 'closed_at' },
    totalPrice: { type: DataTypes.DECIMAL(10, 2), field: 'total_price' },
    trackingNumber: { type: DataTypes.STRING(255), field: 'tracking_number' },
    trackingUrl: { type: DataTypes.STRING(1000), field: 'tracking_url' },
    carrier: { type: DataTypes.STRING(255) },
    channel: { type: DataTypes.STRING(50) },
    orderNumber: { type: DataTypes.STRING(20), field: 'order_number' },
    shippingName: { type: DataTypes.STRING(255), field: 'shipping_name' },
    shippingAddress1: { type: DataTypes.STRING(500), field: 'shipping_address1' },
    shippingAddress2: { type: DataTypes.STRING(500), field: 'shipping_address2' },
    shippingCity: { type: DataTypes.STRING(255), field: 'shipping_city' },
    shippingState: { type: DataTypes.STRING(255), field: 'shipping_state' },
    shippingZip: { type: DataTypes.STRING(20), field: 'shipping_zip' },
    shippingCountry: { type: DataTypes.STRING(255), field: 'shipping_country' },
    shippingPhone: { type: DataTypes.STRING(30), field: 'shipping_phone' },
    billingName: { type: DataTypes.STRING(255), field: 'billing_name' },
    billingAddress1: { type: DataTypes.STRING(500), field: 'billing_address1' },
    billingAddress2: { type: DataTypes.STRING(500), field: 'billing_address2' },
    billingCity: { type: DataTypes.STRING(255), field: 'billing_city' },
    billingState: { type: DataTypes.STRING(255), field: 'billing_state' },
    billingZip: { type: DataTypes.STRING(20), field: 'billing_zip' },
    billingCountry: { type: DataTypes.STRING(255), field: 'billing_country' },
    billingPhone: { type: DataTypes.STRING(30), field: 'billing_phone' },
    customerEmail: { type: DataTypes.STRING(255), field: 'customer_email' },
    customerPhone: { type: DataTypes.STRING(30), field: 'customer_phone' },
    subtotalPrice: { type: DataTypes.DECIMAL(10, 2), field: 'subtotal_price' },
    totalDiscount: { type: DataTypes.DECIMAL(10, 2), field: 'total_discount' },
    totalTax: { type: DataTypes.DECIMAL(10, 2), field: 'total_tax' },
    shippingCharge: { type: DataTypes.DECIMAL(10, 2), field: 'shipping_charge' },
    paymentMethod: { type: DataTypes.STRING(255), field: 'payment_method' },
    orderNote: { type: DataTypes.TEXT, field: 'order_note' },
    tags: { type: DataTypes.STRING(500) },
    cancelReason: { type: DataTypes.STRING(100), field: 'cancel_reason' },
    cancelledAt: { type: DataTypes.DATE, field: 'cancelled_at' },
    shippedAt: { type: DataTypes.DATE, field: 'shipped_at' },
    deliveredAt: { type: DataTypes.DATE, field: 'delivered_at' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    tableName: 'orders',
    underscored: true,
  }
);

export default Order;
