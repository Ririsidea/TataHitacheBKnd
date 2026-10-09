import Order from './Order';
import OrderLineItem from './OrderLineItem';
import WebhookLog from './WebhookLog';
import InventorySnapshot from './InventorySnapshot';
import User from './User';
import DailyExport from './DailyExport';
import AdminDailyExport from './AdminDailyExport';
import { attachOrderHooks } from '../services/orderEvents';

Order.hasMany(OrderLineItem, { as: 'lineItems', foreignKey: 'orderId', onDelete: 'CASCADE' });
OrderLineItem.belongsTo(Order, { foreignKey: 'orderId' });

// Every order write is announced to the live (SSE) clients - see services/orderEvents.ts.
attachOrderHooks(Order);

export { Order, OrderLineItem, WebhookLog, InventorySnapshot, User, DailyExport, AdminDailyExport };
