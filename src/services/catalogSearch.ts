// Product list + search over the catalog rows (one row per variant, see productMapper.ts).
// Pure functions - no Shopify, no Express - so the rules are unit-tested in test/catalogSearch.test.ts.
//   parseCatalogQuery(req.query)  -> { error } | { params }
//   buildIndex(rows)              -> the searchable catalog (built once per catalog copy)
//   searchCatalog(index, params)  -> { data, meta }   (always one page of PAGE_SIZE rows)

import { PAGE_SIZE, singleValueError, parsePage, offsetOf, pageMeta, type PageMeta, type Query } from '../utils/paginate';
import type { CatalogRow } from './shopify/productMapper';

const MAX_QUERY_LENGTH = 100;

const SORTS = ['relevance', 'title', 'price', 'stock', 'newest'] as const;
const ORDERS = ['asc', 'desc'] as const;
export type Sort = (typeof SORTS)[number];
export type Order = (typeof ORDERS)[number];
// Direction used when ?order= is not given. "relevance" is best-first.
const DEFAULT_ORDER: Record<Sort, Order> = { relevance: 'desc', title: 'asc', price: 'asc', stock: 'desc', newest: 'desc' };

const PARAMS = ['page', 'q', 'sku', 'category', 'vendor', 'tag', 'color', 'size', 'minPrice', 'maxPrice', 'inStock', 'sort', 'order', 'fresh'];
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export interface CatalogParams {
  page: number;
  q: string;
  tokens: string[];
  skus: string[] | null;
  category: string | null;
  vendor: string | null;
  tag: string | null;
  color: string | null;
  size: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  inStock: boolean | null;
  sort: Sort;
  order: Order;
  fresh: boolean;
}

export type CatalogQueryResult = { params: CatalogParams; error?: undefined } | { error: string; params?: undefined };

// ---- query string -> validated params --------------------------------------------------
export function parseCatalogQuery(query: Query = {}): CatalogQueryResult {
  const fail = (message: string): { error: string } => ({ error: message });
  const isSet = (name: string): boolean => query[name] !== undefined;
  const read = (name: string): string => (typeof query[name] === 'string' ? (query[name] as string).trim() : '');
  // Parameters this endpoint does not know are ignored (page size is fixed, there is no limit).
  const repeated = singleValueError(query, PARAMS);
  if (repeated) return fail(repeated);

  const parsedPage = parsePage(query.page);
  if (parsedPage.error !== undefined) return fail(parsedPage.error);
  const page = parsedPage.page;

  const q = read('q');
  if (q.length > MAX_QUERY_LENGTH) return fail(`q must be at most ${MAX_QUERY_LENGTH} characters`);

  const price: { minPrice?: number; maxPrice?: number } = {};
  for (const name of ['minPrice', 'maxPrice'] as const) {
    if (!isSet(name)) continue;
    const raw = read(name);
    if (!NUMBER_PATTERN.test(raw)) return fail(`${name} must be a number`);
    price[name] = Number(raw);
  }
  if (price.minPrice !== undefined && price.maxPrice !== undefined && price.minPrice > price.maxPrice) {
    return fail('minPrice must not be greater than maxPrice');
  }

  const flags: { inStock?: boolean; fresh?: boolean } = {};
  for (const name of ['inStock', 'fresh'] as const) {
    if (!isSet(name)) continue;
    const raw = read(name).toLowerCase();
    if (raw !== 'true' && raw !== 'false') return fail(`${name} must be true or false`);
    flags[name] = raw === 'true';
  }

  const sortText = isSet('sort') ? read('sort').toLowerCase() : q ? 'relevance' : 'title';
  if (!(SORTS as readonly string[]).includes(sortText)) return fail(`sort must be one of: ${SORTS.join(', ')}`);
  const sort = sortText as Sort;
  const orderText = isSet('order') ? read('order').toLowerCase() : DEFAULT_ORDER[sort];
  if (!(ORDERS as readonly string[]).includes(orderText)) return fail(`order must be one of: ${ORDERS.join(', ')}`);
  const order = orderText as Order;

  const skus = read('sku').split(',').map((s) => s.trim()).filter(Boolean);
  const text = (name: string): string | null => read(name) || null;

  return {
    params: {
      page,
      q,
      tokens: q.toLowerCase().split(/\s+/).filter(Boolean),
      skus: skus.length ? skus : null,
      category: text('category'),
      vendor: text('vendor'),
      tag: text('tag'),
      color: text('color'),
      size: text('size'),
      minPrice: price.minPrice ?? null,
      maxPrice: price.maxPrice ?? null,
      inStock: flags.inStock ?? null,
      sort,
      order,
      fresh: flags.fresh ?? false,
    },
  };
}

// ---- searchable catalog ------------------------------------------------------------------
const lower = (value: unknown): string | null => (value === null || value === undefined ? null : String(value).toLowerCase());

function uniqueSorted(values: (string | null | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    if (value && !seen.has(String(lower(value)))) seen.set(String(lower(value)), value);
  }
  return [...seen.values()].sort(collator.compare);
}

export interface Facets {
  categories: string[];
  colors: string[];
  sizes: string[];
  priceRange: { min: number; max: number } | null;
}

// The values the filter dropdowns offer. Taken from the whole catalog (not the current
// result) so the lists stay put while the user narrows the search.
function collectFacets(rows: CatalogRow[]): Facets {
  const prices = rows.map((row) => Number(row.price)).filter(Number.isFinite);
  return {
    categories: uniqueSorted(rows.map((row) => row.category)),
    colors: uniqueSorted(rows.map((row) => row.options.color)),
    sizes: uniqueSorted(rows.map((row) => row.options.size)),
    priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
  };
}

interface IndexEntry {
  row: CatalogRow;
  text: string;
  sku: string | null;
  title: string;
  category: string | null;
  vendor: string | null;
  tags: Set<string | null>;
  color: string | null;
  size: string | null;
  price: number;
  created: number;
}

export interface CatalogIndex {
  entries: IndexEntry[];
  facets: Facets;
}

export function buildIndex(rows: CatalogRow[]): CatalogIndex {
  const entries: IndexEntry[] = rows.map((row) => ({
    row,
    // Everything free text can hit, joined with newlines (a search word never contains one,
    // so a word cannot match across two fields).
    text: [row.title, row.sku, row.variantTitle, ...Object.values(row.options), row.category, row.vendor, ...row.tags, row.handle]
      .filter(Boolean)
      .join('\n')
      .toLowerCase(),
    sku: lower(row.sku),
    title: lower(row.title) as string,
    category: lower(row.category),
    vendor: lower(row.vendor),
    tags: new Set(row.tags.map(lower)),
    color: lower(row.options.color),
    size: lower(row.options.size),
    price: Number(row.price),
    created: Date.parse(row.createdAt as string) || 0,
  }));
  return { entries, facets: collectFacets(rows) };
}

// ---- search ------------------------------------------------------------------------------
function matches(entry: IndexEntry, params: CatalogParams): boolean {
  const { row } = entry;
  if (params.skus && !params.skus.some((sku) => lower(sku) === entry.sku)) return false;
  if (params.category && lower(params.category) !== entry.category) return false;
  if (params.vendor && lower(params.vendor) !== entry.vendor) return false;
  if (params.tag && !entry.tags.has(lower(params.tag))) return false;
  if (params.color && lower(params.color) !== entry.color) return false;
  if (params.size && lower(params.size) !== entry.size) return false;
  if (params.inStock !== null && row.availableQty > 0 !== params.inStock) return false;
  if (params.minPrice !== null && !(entry.price >= params.minPrice)) return false;
  if (params.maxPrice !== null && !(entry.price <= params.maxPrice)) return false;
  // Every word must hit some field (partial words are fine); product / variant ids match whole.
  return params.tokens.every((t) => entry.text.includes(t) || row.id === t || row.variantId === t);
}

// Bigger = more relevant: exact SKU, then title starts with the search, then anything else.
function relevance(entry: IndexEntry, phrase: string): number {
  if (!phrase) return 0;
  if (entry.sku === phrase) return 2;
  if (entry.title.startsWith(phrase)) return 1;
  return 0;
}

const SORT_KEYS: Record<Exclude<Sort, 'relevance' | 'title'>, (e: IndexEntry) => number> = {
  price: (e) => (Number.isFinite(e.price) ? e.price : 0),
  stock: (e) => e.row.availableQty,
  newest: (e) => e.created,
};

function compareEntries(a: IndexEntry, b: IndexEntry, params: CatalogParams, phrase: string): number {
  const direction = params.order === 'desc' ? -1 : 1;
  let diff = 0;
  if (params.sort === 'relevance') diff = relevance(a, phrase) - relevance(b, phrase);
  else if (params.sort === 'title') diff = collator.compare(a.row.title, b.row.title);
  else diff = SORT_KEYS[params.sort](a) - SORT_KEYS[params.sort](b);
  if (diff) return diff * direction;
  // Stable, deterministic order so a row never appears on two pages or on none.
  return (
    collator.compare(a.row.title, b.row.title) ||
    collator.compare(a.row.variantTitle || '', b.row.variantTitle || '') ||
    collator.compare(a.row.sku || '', b.row.sku || '') ||
    collator.compare(a.row.variantId, b.row.variantId)
  );
}

export interface CatalogPage {
  data: CatalogRow[];
  meta: PageMeta & { facets: Facets };
}

export function searchCatalog(index: CatalogIndex, params: CatalogParams): CatalogPage {
  const phrase = params.tokens.join(' ');
  const found = index.entries.filter((entry) => matches(entry, params));
  found.sort((a, b) => compareEntries(a, b, params, phrase));
  const start = offsetOf(params.page);

  return {
    data: found.slice(start, start + PAGE_SIZE).map((entry) => entry.row),
    meta: {
      ...pageMeta({
        page: params.page,
        total: found.length,
        filters: {
          q: params.q || null,
          sku: params.skus,
          category: params.category,
          vendor: params.vendor,
          tag: params.tag,
          color: params.color,
          size: params.size,
          minPrice: params.minPrice,
          maxPrice: params.maxPrice,
          inStock: params.inStock,
          sort: params.sort,
          order: params.order,
        },
      }),
      facets: index.facets,
    },
  };
}

export { PAGE_SIZE, MAX_QUERY_LENGTH, SORTS, ORDERS };
