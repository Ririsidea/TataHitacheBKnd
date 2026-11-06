import axios from 'axios';
import * as shopify from './shopify/client';
import { errorMessage, httpError } from '../utils/errors';

export type DateFilter =
  | 'days'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'previous_week'
  | 'this_month'
  | 'previous_month'
  | 'this_year'
  | 'previous_year'
  | 'custom';

interface DateRange {
  startDate: string;
  endDate: string;
}

export interface TrendingProductsResult {
  startDate: string;
  endDate: string;
  partial: boolean;
  data: TrendingProduct[];
}

interface TrendingOrderLine {
  quantity: number;
  discountedTotalSet?: { shopMoney?: { amount?: string | null } | null } | null;
  product?: { id: string; title: string; featuredImage?: { url: string } | null } | null;
  variant?: { id: string; title: string; sku: string | null } | null;
}

interface TrendingOrder {
  id: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  lineItems: { nodes: TrendingOrderLine[] };
}

interface TrendingOrdersResponse {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: TrendingOrder[];
  };
}

export interface TrendingProduct {
  productId: string;
  productTitle: string;
  productImage: string | null;
  variantId: string;
  variantTitle: string;
  sku: string | null;
  orders: number;
  quantityOrdered: number;
  netItemsSold: number;
  netSales: number;
}

const STORE_TIMEZONE = 'Asia/Kolkata';
const TRENDING_ORDERS_QUERY = `
  query TrendingOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        cancelledAt
        displayFinancialStatus
        lineItems(first: 50) {
          nodes {
            quantity
            discountedTotalSet { shopMoney { amount currencyCode } }
            product { id title featuredImage { url } }
            variant { id title sku }
          }
        }
      }
    }
  }
`;

function numericId(gid: string | null | undefined): string {
  const match = /\/(\d+)$/.exec(gid || '');
  return match ? match[1] : String(gid || '');
}

function dateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function dateOnly(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function shiftDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return dateOnly(year, month, day + days);
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return dateOnly(year, month, day) === value;
}

function todayInStore(): string {
  const now = dateParts(new Date());
  return dateOnly(now.year, now.month, now.day);
}

export function resolveDateRange(
  days: number,
  filter: DateFilter = 'days',
  customStartDate?: string,
  customEndDate?: string
): DateRange {
  const today = todayInStore();
  if (filter === 'days') return { startDate: shiftDate(today, -days), endDate: today };
  if (filter === 'today') return { startDate: today, endDate: today };
  if (filter === 'yesterday') {
    const yesterday = shiftDate(today, -1);
    return { startDate: yesterday, endDate: yesterday };
  }

  const todayParts = today.split('-').map(Number);
  const year = todayParts[0];
  const month = todayParts[1];
  const dayOfWeek = new Date(Date.UTC(year, month - 1, todayParts[2])).getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const thisWeekStart = shiftDate(today, mondayOffset);
  if (filter === 'this_week') return { startDate: thisWeekStart, endDate: shiftDate(thisWeekStart, 6) };
  if (filter === 'previous_week') {
    const previousWeekStart = shiftDate(thisWeekStart, -7);
    return { startDate: previousWeekStart, endDate: shiftDate(previousWeekStart, 6) };
  }
  if (filter === 'this_month') return { startDate: dateOnly(year, month, 1), endDate: dateOnly(year, month + 1, 0) };
  if (filter === 'previous_month') {
    return { startDate: dateOnly(year, month - 1, 1), endDate: dateOnly(year, month, 0) };
  }
  if (filter === 'this_year') return { startDate: dateOnly(year, 1, 1), endDate: dateOnly(year, 12, 31) };
  if (filter === 'previous_year') return { startDate: dateOnly(year - 1, 1, 1), endDate: dateOnly(year - 1, 12, 31) };
  if (filter === 'custom') {
    if (!isValidDateOnly(customStartDate) || !isValidDateOnly(customEndDate)) {
      throw httpError(400, 'startDate and endDate must be valid dates in YYYY-MM-DD format');
    }
    if (customStartDate > customEndDate) throw httpError(400, 'startDate must not be after endDate');
    return { startDate: customStartDate, endDate: customEndDate };
  }
  throw httpError(400, 'dateFilter must be today, yesterday, this_week, previous_week, this_month, previous_month, this_year, previous_year, or custom');
}

function retryDelayMs(error: unknown, attempt: number): number {
  if (axios.isAxiosError(error)) {
    const raw = error.response?.headers?.['retry-after'];
    const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

function shouldRetry(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status === 429 || (status !== undefined && status >= 500);
}

async function requestOrders(variables: Record<string, unknown>): Promise<TrendingOrdersResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await shopify.graphqlRequest<TrendingOrdersResponse>(TRENDING_ORDERS_QUERY, variables);
    } catch (err: unknown) {
      if (!shouldRetry(err) || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(err, attempt)));
    }
  }
}

function isExcludedOrder(order: TrendingOrder): boolean {
  const financialStatus = String(order.displayFinancialStatus || '').toUpperCase();
  return Boolean(order.cancelledAt) || financialStatus === 'VOIDED' || financialStatus === 'REFUNDED';
}

interface VariantAggregate {
  variantId: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
}

interface Aggregate {
  productId: string;
  productTitle: string;
  productImage: string | null;
  orderIds: Set<string>;
  quantityOrdered: number;
  netSales: number;
  variants: Map<string, VariantAggregate>;
}

function aggregateOrders(orders: TrendingOrder[]): TrendingProduct[] {
  const groups = new Map<string, Aggregate>();
  for (const order of orders) {
    if (isExcludedOrder(order)) continue;
    for (const line of order.lineItems.nodes) {
      if (!line.product) continue;
      const productId = numericId(line.product.id);
      if (!productId) continue;
      const variantId = numericId(line.variant?.id) || productId;
      let group = groups.get(productId);
      if (!group) {
        group = {
          productId,
          productTitle: line.product.title,
          productImage: line.product.featuredImage?.url || null,
          orderIds: new Set<string>(),
          quantityOrdered: 0,
          netSales: 0,
          variants: new Map<string, VariantAggregate>(),
        };
        groups.set(productId, group);
      }
      group.orderIds.add(order.id);
      const quantity = Number(line.quantity) || 0;
      group.quantityOrdered += quantity;
      group.netSales += Number(line.discountedTotalSet?.shopMoney?.amount || 0) || 0;
      const variant = group.variants.get(variantId) || {
        variantId,
        variantTitle: line.variant?.title || '',
        sku: line.variant?.sku ?? null,
        quantity: 0,
      };
      variant.quantity += quantity;
      group.variants.set(variantId, variant);
    }
  }

  return [...groups.values()]
    .map((group) => {
      const representative = [...group.variants.values()].sort((a, b) => b.quantity - a.quantity)[0];
      return {
        productId: group.productId,
        productTitle: group.productTitle,
        productImage: group.productImage,
        variantId: representative?.variantId || group.productId,
        variantTitle: representative?.variantTitle || '',
        sku: representative?.sku ?? null,
        orders: group.orderIds.size,
        quantityOrdered: group.quantityOrdered,
        netItemsSold: group.quantityOrdered,
        netSales: Math.round(group.netSales * 100) / 100,
      };
    })
    .sort((a, b) => b.netItemsSold - a.netItemsSold);
}

export async function getTrendingProducts(
  days: number,
  limit: number,
  filter: DateFilter = 'days',
  customStartDate?: string,
  customEndDate?: string
): Promise<TrendingProductsResult> {
  const range = resolveDateRange(days, filter, customStartDate, customEndDate);
  const query = `created_at:>=${range.startDate} AND created_at:<=${range.endDate}`;
  const orders: TrendingOrder[] = [];
  let after: string | null = null;

  try {
    for (let page = 0; page < 50; page += 1) {
      const response = await requestOrders({ first: 50, after, query });
      orders.push(...response.orders.nodes);
      if (!response.orders.pageInfo.hasNextPage || !response.orders.pageInfo.endCursor) break;
      after = response.orders.pageInfo.endCursor;
    }
  } catch (err: unknown) {
    throw httpError(502, `Shopify trending products query failed: ${errorMessage(err)}`);
  }

  const availableFrom = shiftDate(todayInStore(), -59);
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    partial: range.startDate < availableFrom,
    data: aggregateOrders(orders).slice(0, limit),
  };
}
