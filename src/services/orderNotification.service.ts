import { Op } from 'sequelize';
import type { OrderInstance } from '../models/Order';
import { Order } from '../models';

// Email delivery is intentionally isolated. Replace these two mock functions with the real
// provider later; the order workflow and its idempotency guards do not need to change.
function sendEmployeeOrderConfirmationEmail(email: string, shopifyOrderId: string | null): void {
  console.log(`[EMAIL MOCK] Order confirmation would be sent to: ${email} for order ${shopifyOrderId || 'unknown'}`);
}

function sendPayrollOrderNotificationEmail(shopifyOrderId: string | null): void {
  console.log(`[EMAIL MOCK] Payroll Department notification would be sent for order ${shopifyOrderId || 'unknown'}`);
}

export async function notifyOrderPlaced(order: OrderInstance): Promise<void> {
  if (!order.email) return;
  const now = new Date();
  const [claimed] = await Order.update(
    { employeeConfirmationNotifiedAt: now, payrollNotifiedAt: now },
    { where: { id: order.id, employeeConfirmationNotifiedAt: { [Op.is]: null }, payrollNotifiedAt: { [Op.is]: null } } }
  );
  if (!claimed) return;
  sendEmployeeOrderConfirmationEmail(order.email, order.shopifyOrderId);
  sendPayrollOrderNotificationEmail(order.shopifyOrderId);
}
