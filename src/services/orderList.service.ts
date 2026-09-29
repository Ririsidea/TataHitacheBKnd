import { Op, fn, col, where as sqlWhere, type WhereOptions } from 'sequelize';
import { Order, OrderLineItem } from '../models';
import { orderFlags, type OrderFlags } from '../utils/orderStatus';
import {
  singleValueError,
  parseCursor,
  pageInfo,
  parseDateRange,
  likeContains,
  type PageInfo,
  type Query,
} from '../utils/paginate';
import { pickRenamed, RENAMED_FIELDS } from '../utils/fieldAliases';

// One cursor page of orders, newest first - the list behind GET /api/dashboard/orders (one
// employee's orders) and GET /api/admin/orders (everyone's). Pagination contract: utils/paginate.ts.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_STATUS_LENGTH = 50;
const MAX_SEARCH_LENGTH = 100;

export interface OrderListParams {
  limit: number;
  offset: number;
  email: string | null;
  status: string | null;
  fromDate: string | null;
  toDate: string | null;
  from: Date | null;
  to: Date | null;
  q: string | null;
}

export type OrderListQueryResult = { params: OrderListParams; error?: undefined } | { error: string; params?: undefined };

// req.query -> { error } | { params }.
//   employeeRequired  the list is always for one employee (?email=)
//   allowLegacyEmailAlias  admin-only compatibility for the old ?employeeEmail= spelling
//   allowSearch       admin only: ?q= matches Shopify order id, employee name or email
// fromDate / toDate: "YYYY-MM-DD" (a whole UTC day) or an ISO 8601 date-time (that instant), on the
// order's creation time, both ends inclusive.
export function parseOrderListQuery(
  query: Query = {},
  {
    employeeRequired = false,
    allowSearch = false,
    allowLegacyEmailAlias = false,
  }: { employeeRequired?: boolean; allowSearch?: boolean; allowLegacyEmailAlias?: boolean } = {}
): OrderListQueryResult {
  const names = [
    'limit',
    'after',
    'before',
    'email',
    ...(allowLegacyEmailAlias ? [RENAMED_FIELDS.email] : []),
    'status',
    'fromDate',
    'toDate',
    ...(allowSearch ? ['q'] : []),
  ];
  const repeated = singleValueError(query, names);
  if (repeated) return { error: repeated };

  const parsedCursor = parseCursor(query);
  if (parsedCursor.error !== undefined) return { error: parsedCursor.error };

  const text = (name: string): string => (typeof query[name] === 'string' ? (query[name] as string).trim() : '');

  const rawEmail = allowLegacyEmailAlias ? pickRenamed(query, 'email') : query.email;
  const email = (typeof rawEmail === 'string' ? rawEmail.trim() : '').toLowerCase();
  if (employeeRequired && (!email || email.length > 255 || !EMAIL_PATTERN.test(email))) {
    return { error: 'A valid email query parameter is required' };
  }
  if (email && (email.length > 255 || !EMAIL_PATTERN.test(email))) {
    return { error: 'email must be a valid email address' };
  }

  const status = text('status').toLowerCase();
  if (status.length > MAX_STATUS_LENGTH) return { error: `status must be at most ${MAX_STATUS_LENGTH} characters` };

  const range = parseDateRange(query, 'fromDate', 'toDate');
  if (range.error !== undefined) return { error: range.error };

  const q = allowSearch ? text('q') : '';
  if (q.length > MAX_SEARCH_LENGTH) return { error: `q must be at most ${MAX_SEARCH_LENGTH} characters` };

  return {
    params: {
      limit: parsedCursor.limit,
      offset: parsedCursor.offset,
      email: email || null,
      status: status || null,
      fromDate: text('fromDate') || null,
      toDate: text('toDate') || null,
      from: range.from,
      to: range.to,
      q: q || null,
    },
  };
}

export interface OrderListPage {
  data: (Record<string, unknown> & OrderFlags)[];
  pageInfo: PageInfo;
}

// params from parseOrderListQuery -> { data, pageInfo }.
export async function listOrders(params: OrderListParams): Promise<OrderListPage> {
  const where: Record<string, unknown> = {};
  if (params.email) where.email = params.email;
  if (params.from || params.to) {
    const createdAt: Record<symbol, Date> = {};
    if (params.from) createdAt[Op.gte] = params.from;
    if (params.to) createdAt[Op.lte] = params.to;
    where.createdAt = createdAt;
  }
  const conditions: WhereOptions[] = [where as WhereOptions];
  if (params.status) conditions.push(sqlWhere(fn('LOWER', col('Order.status')), params.status));
  if (params.q) {
    const like = { [Op.like]: likeContains(params.q) };
    conditions.push({ [Op.or]: [{ shopifyOrderId: like }, { email: like }, { name: like }] });
  }

  const { rows, count } = await Order.findAndCountAll({
    where: { [Op.and]: conditions },
    include: [{ model: OrderLineItem, as: 'lineItems' }],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: params.limit,
    offset: params.offset,
    distinct: true,
  });

  return {
    data: rows.map((order) => ({ ...order.toJSON(), ...orderFlags(order) })),
    pageInfo: pageInfo({
      limit: params.limit,
      offset: params.offset,
      total: count,
      filters: {
        email: params.email,
        status: params.status,
        fromDate: params.fromDate,
        toDate: params.toDate,
        ...(params.q !== null ? { q: params.q } : {}),
      },
    }),
  };
}
