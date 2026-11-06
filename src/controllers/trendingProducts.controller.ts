import type { NextFunction, Request, Response } from 'express';
import { getTrendingProducts, type DateFilter } from '../services/trendingProducts.service';
import { httpError } from '../utils/errors';

function readInteger(body: Record<string, unknown>, name: 'days' | 'limit', fallback: number, max: number): number {
  const value = body[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw httpError(400, `${name} must be an integer between 1 and ${max}`);
  }
  return value as number;
}

export async function getTrendingProductsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const days = readInteger(body, 'days', 30, 60);
    const limit = readInteger(body, 'limit', 10, 50);
    const dateFilter = body.period ?? body.dateFilter ?? 'days';
    const validFilters = new Set<DateFilter>(['days', 'today', 'yesterday', 'this_week', 'previous_week', 'this_month', 'previous_month', 'this_year', 'previous_year', 'custom']);
    if (typeof dateFilter !== 'string' || !validFilters.has(dateFilter as DateFilter)) {
      throw httpError(400, 'period must be today, yesterday, this_week, previous_week, this_month, previous_month, this_year, previous_year, or custom');
    }
    if (dateFilter === 'custom' && (body.startDate === undefined || body.endDate === undefined)) {
      throw httpError(400, 'startDate and endDate are required when dateFilter is custom');
    }
    const result = await getTrendingProducts(
      days,
      limit,
      dateFilter as DateFilter,
      typeof body.startDate === 'string' ? body.startDate : undefined,
      typeof body.endDate === 'string' ? body.endDate : undefined
    );
    res.json({
      success: true,
      period: dateFilter,
      startDate: result.startDate,
      endDate: result.endDate,
      limit,
      count: result.data.length,
      partial: result.partial,
      ...(result.partial ? { note: 'Shopify only provides the last 60 days of orders' } : {}),
      data: result.data,
    });
  } catch (err: unknown) {
    next(err);
  }
}
