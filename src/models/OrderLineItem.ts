import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

export interface OrderLineItemAttributes {
  id: number;
  orderId: number;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  // DECIMAL columns come back from MySQL as strings.
  price: string | number | null;
  // Order detail (see services/orderDetails.ts) - from the webhook payload only.
  variantTitle: string | null;
  lineDiscount: string | number | null;
  lineTax: string | number | null;
}

export type OrderLineItemCreationAttributes = Partial<OrderLineItemAttributes> & { orderId: number };

export interface OrderLineItemInstance
  extends Model<OrderLineItemAttributes, OrderLineItemCreationAttributes>,
    OrderLineItemAttributes {}

const OrderLineItem = sequelize.define<OrderLineItemInstance>(
  'OrderLineItem',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    orderId: { type: DataTypes.INTEGER, allowNull: false, field: 'order_id' },
    sku: { type: DataTypes.STRING(255) },
    title: { type: DataTypes.STRING(500) },
    quantity: { type: DataTypes.INTEGER },
    price: { type: DataTypes.DECIMAL(10, 2) },
    variantTitle: { type: DataTypes.STRING(255), field: 'variant_title' },
    lineDiscount: { type: DataTypes.DECIMAL(10, 2), field: 'line_discount' },
    lineTax: { type: DataTypes.DECIMAL(10, 2), field: 'line_tax' },
  },
  {
    tableName: 'order_line_items',
    underscored: true,
    timestamps: false,
    indexes: [{ fields: ['order_id'] }],
  }
);

export default OrderLineItem;
