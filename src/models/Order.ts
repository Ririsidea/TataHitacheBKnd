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
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    tableName: 'orders',
    underscored: true,
  }
);

export default Order;
