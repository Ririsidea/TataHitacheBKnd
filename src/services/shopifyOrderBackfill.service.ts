import * as shopify from './shopify/client';
import {
  employeeFieldsFromShopifyOrder,
  importMapOrderIfMissing,
  isMapShopifyOrder,
} from './orderSync.service';
import type { ShopifyOrder } from '../types/shopify';

export interface ShopifyMapBackfillResult {
  scannedShopifyOrders: number;
  mapOrders: number;
  eligibleOrders: number;
  inserted: number;
  skippedDuplicates: number;
  skippedNotMap: number;
  skippedMissingEmployee: number;
  failed: number;
}

let inFlight: Promise<ShopifyMapBackfillResult> | null = null;

function safeErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const response = (err as { response?: { status?: unknown } }).response;
    if (typeof response?.status === 'number') return `Shopify returned HTTP ${response.status}`;
  }
  return err instanceof Error ? err.message : 'unknown error';
}

async function runBackfill(): Promise<ShopifyMapBackfillResult> {
  const result: ShopifyMapBackfillResult = {
    scannedShopifyOrders: 0,
    mapOrders: 0,
    eligibleOrders: 0,
    inserted: 0,
    skippedDuplicates: 0,
    skippedNotMap: 0,
    skippedMissingEmployee: 0,
    failed: 0,
  };

  const shopifyOrders: ShopifyOrder[] = await shopify.listAllShopifyOrders();
  for (const shopifyOrder of shopifyOrders) {
    result.scannedShopifyOrders += 1;
    if (!isMapShopifyOrder(shopifyOrder)) {
      result.skippedNotMap += 1;
      continue;
    }
    result.mapOrders += 1;
    if (!employeeFieldsFromShopifyOrder(shopifyOrder)) {
      result.skippedMissingEmployee += 1;
      continue;
    }
    result.eligibleOrders += 1;

    try {
      const imported = await importMapOrderIfMissing(shopifyOrder);
      if (imported.outcome === 'inserted') result.inserted += 1;
      else if (imported.outcome === 'duplicate') result.skippedDuplicates += 1;
    } catch (err) {
      result.failed += 1;
      // The Shopify order id is not customer data; the response/error body is deliberately not
      // logged because it can contain checkout/customer details.
      console.error(`[shopify-backfill] failed for Shopify order ${String(shopifyOrder.id)}: ${safeErrorMessage(err)}`);
    }
  }

  console.log(
    `[shopify-backfill] scanned ${result.scannedShopifyOrders}, inserted ${result.inserted}, `
      + `duplicates ${result.skippedDuplicates}, failed ${result.failed}`
  );
  return result;
}

// A single process-wide in-flight promise prevents two admin clicks or two operators from
// scanning/importing the same Shopify history concurrently. A later invocation is still safe
// because the database unique constraint is the final idempotency guard.
export function backfillMissingMapOrders(): Promise<ShopifyMapBackfillResult> {
  if (inFlight) return inFlight;
  inFlight = runBackfill().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
