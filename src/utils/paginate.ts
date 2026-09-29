// The one pagination contract every list endpoint follows (product list, orders, events, SAP
// exports, employees): cursor pagination, chosen with ?limit= (default 50) and ?after= / ?before=
// (opaque cursors, mutually exclusive), answered as
//   { success, data: [...rows], pageInfo: { limit, total, hasNextPage, hasPreviousPage,
//                                             nextCursor, previousCursor, filters } }
// There is no ?page= any more - a page past the end is not an error (200, empty data, correct
// pageInfo); a bad ?limit=/?after=/?before= is a 400.

export const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const INTEGER = /^\d+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A parsed query string as Express hands it over (repeated parameters arrive as arrays). */
export type Query = Record<string, unknown>;

export interface PageInfo {
  limit: number;
  // The 0-based index of the first row in this page - lets a "Showing X-Y of Z" line be
  // rendered without decoding a cursor.
  offset: number;
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor: string | null;
  previousCursor: string | null;
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

// An opaque cursor is just the offset it points at, base64url-encoded so it is never read or
// constructed by hand - { o: <offset> }. Cursors are only ever compared to the filtered,
// sorted result they were issued for, which the caller always resends alongside them (the
// frontend keeps its filters when it follows a cursor), so an offset is enough: it never needs
// to survive a different filter set.
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : null;
  } catch {
    return null;
  }
}

export type CursorResult = { limit: number; offset: number; error?: undefined } | { error: string; limit?: undefined; offset?: undefined };

// -> { limit, offset } or { error }. Missing limit is DEFAULT_LIMIT; missing after/before is
// offset 0 (the first page).
export function parseCursor(query: Query = {}): CursorResult {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const limitText = typeof query.limit === 'string' ? query.limit.trim() : '';
    if (!INTEGER.test(limitText) || Number(limitText) < 1) return { error: 'limit must be a positive integer' };
    limit = Number(limitText);
    if (limit > MAX_LIMIT) return { error: `limit must be at most ${MAX_LIMIT}` };
  }

  const afterText = typeof query.after === 'string' ? query.after.trim() : '';
  const beforeText = typeof query.before === 'string' ? query.before.trim() : '';
  if (afterText && beforeText) return { error: 'after and before cannot both be given' };

  if (afterText) {
    const offset = decodeCursor(afterText);
    if (offset === null) return { error: 'after is not a valid cursor' };
    return { limit, offset };
  }
  if (beforeText) {
    const offset = decodeCursor(beforeText);
    if (offset === null) return { error: 'before is not a valid cursor' };
    return { limit, offset };
  }
  return { limit, offset: 0 };
}

// A list whose only parameters are ?limit=/?after=/?before= -> { limit, offset } or { error }.
export function parseCursorQuery(query: Query, extraNames: string[] = []): CursorResult {
  const repeated = singleValueError(query, ['limit', 'after', 'before', ...extraNames]);
  return repeated ? { error: repeated } : parseCursor(query);
}

export function pageInfo({
  limit,
  offset,
  total,
  filters = {},
}: {
  limit: number;
  offset: number;
  total: number;
  filters?: Record<string, unknown>;
}): PageInfo {
  const hasNextPage = offset + limit < total;
  const hasPreviousPage = offset > 0;
  return {
    limit,
    offset,
    total,
    hasNextPage,
    hasPreviousPage,
    nextCursor: hasNextPage ? encodeCursor(offset + limit) : null,
    previousCursor: hasPreviousPage ? encodeCursor(Math.max(0, offset - limit)) : null,
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
