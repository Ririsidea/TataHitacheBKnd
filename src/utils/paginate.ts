// The one pagination contract every list endpoint follows (product list, orders, events, SAP
// exports, employees): a FIXED page of PAGE_SIZE rows, chosen with ?page=, answered as
//   { success, data: [...rows], meta: { page, limit, total, totalPages, hasNextPage, hasPrevPage, filters } }
// A page past the end is not an error (200, empty data, correct meta); a bad ?page= is a 400.
// There is no page-size parameter and no "return everything" mode.

export const PAGE_SIZE = 50;

const INTEGER = /^\d+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A parsed query string as Express hands it over (repeated parameters arrive as arrays). */
export type Query = Record<string, unknown>;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  filters: Record<string, unknown>;
}

// A repeated parameter (?q=a&q=b) arrives as an array - refuse it rather than guess.
// Parameters an endpoint does not know are ignored.
export function singleValueError(query: Query, names: string[]): string | null {
  for (const name of names) {
    if (query[name] !== undefined && typeof query[name] !== 'string') return `${name} must be given once`;
  }
  return null;
}

export type PageResult = { page: number; error?: undefined } | { error: string; page?: undefined };

// -> { page } or { error }. A missing page is page 1.
export function parsePage(value: unknown): PageResult {
  if (value === undefined) return { page: 1 };
  const text = typeof value === 'string' ? value.trim() : '';
  const page = INTEGER.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(page) || page < 1) return { error: 'page must be an integer of at least 1' };
  return { page };
}

// A list whose only parameter is ?page= -> { page } or { error }.
export function parsePageQuery(query: Query, extraNames: string[] = []): PageResult {
  const repeated = singleValueError(query, ['page', ...extraNames]);
  return repeated ? { error: repeated } : parsePage(query.page);
}

export const offsetOf = (page: number): number => (page - 1) * PAGE_SIZE;

export function pageMeta({ page, total, filters = {} }: { page: number; total: number; filters?: Record<string, unknown> }): PageMeta {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  return {
    page,
    limit: PAGE_SIZE,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    filters,
  };
}

export type DateBoundResult = { date: Date; error?: undefined } | { error: string; date?: undefined };

// A date filter: "2026-09-25" (a whole UTC day) or a full ISO 8601 date-time such as
// "2026-09-24T18:30:00.000Z" / "2026-09-25T00:00:00+05:30" (that exact instant, so a client can send
// its own local-day boundaries). `edge` says which end a whole day means: 'start' = 00:00:00.000,
// 'end' = 23:59:59.999 (both UTC). -> { date } or { error }.
export function parseDateBound(name: string, value: unknown, edge: 'start' | 'end'): DateBoundResult {
  const text = typeof value === 'string' ? value.trim() : '';
  const message = `${name} must be a date (YYYY-MM-DD) or an ISO 8601 date-time`;
  if (DATE_ONLY.test(text)) {
    const date = new Date(`${text}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`);
    // new Date() rolls 2026-02-31 over to March - a real calendar day reads back unchanged.
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return { error: message };
    return { date };
  }
  if (DATE_TIME.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return { date };
  }
  return { error: message };
}

export type DateRange = { from: Date | null; to: Date | null; error?: undefined } | { error: string; from?: undefined; to?: undefined };

// fromDate / toDate together -> { from, to } (each a Date or null) or { error }.
export function parseDateRange(query: Query, fromName: string, toName: string): DateRange {
  const range: { from: Date | null; to: Date | null } = { from: null, to: null };
  const bounds: [string, 'from' | 'to', 'start' | 'end'][] = [
    [fromName, 'from', 'start'],
    [toName, 'to', 'end'],
  ];
  for (const [name, key, edge] of bounds) {
    if (query[name] === undefined) continue;
    const parsed = parseDateBound(name, query[name], edge);
    if (parsed.error !== undefined) return { error: parsed.error };
    range[key] = parsed.date;
  }
  if (range.from && range.to && range.from > range.to) return { error: `${fromName} must not be after ${toName}` };
  return range;
}

export type DayRange = { from: string | null; to: string | null; error?: undefined } | { error: string; from?: undefined; to?: undefined };

// A calendar day for a DATE column: "YYYY-MM-DD" (a real day), returned as that same string.
// fromName / toName together -> { from, to } (each a string or null) or { error }.
export function parseDayRange(query: Query, fromName: string, toName: string): DayRange {
  const range: { from: string | null; to: string | null } = { from: null, to: null };
  const bounds: [string, 'from' | 'to'][] = [
    [fromName, 'from'],
    [toName, 'to'],
  ];
  for (const [name, key] of bounds) {
    if (query[name] === undefined) continue;
    const value = query[name];
    const text = typeof value === 'string' ? value.trim() : '';
    const day = new Date(`${text}T00:00:00.000Z`);
    if (!DATE_ONLY.test(text) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) {
      return { error: `${name} must be a date (YYYY-MM-DD)` };
    }
    range[key] = text;
  }
  if (range.from && range.to && range.from > range.to) return { error: `${fromName} must not be after ${toName}` };
  return range;
}

// LIKE pattern that matches `text` literally anywhere (escapes \, % and _).
export const likeContains = (text: string): string => `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;
