import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { isMiscProduct } from "@cubby/shared";
import type { z } from "zod";

export type InventoryItem = z.infer<typeof inventoryListItemOut>;

type InventoryValuationBreakdown = {
  key: string;
  label: string;
  valuation: number;
};

/** Per-category breakdown with counts and item names */
type PricingCategorySummary = {
  count: number;
  itemNames: string[];
};

/** Pricing status across three categories */
export type PricingStatus = {
  priced: PricingCategorySummary;
  missingPricing: PricingCategorySummary;
  miscNoPrice: PricingCategorySummary;
};

/** Create an empty pricing status object */
export function emptyPricingStatus(): PricingStatus {
  return {
    priced: { count: 0, itemNames: [] },
    missingPricing: { count: 0, itemNames: [] },
    miscNoPrice: { count: 0, itemNames: [] },
  };
}

/** Merge multiple pricing statuses into one (for aggregating children) */
export function mergePricingStatus(statuses: PricingStatus[]): PricingStatus {
  const result = emptyPricingStatus();
  for (const s of statuses) {
    result.priced.count += s.priced.count;
    result.priced.itemNames.push(...s.priced.itemNames);
    result.missingPricing.count += s.missingPricing.count;
    result.missingPricing.itemNames.push(...s.missingPricing.itemNames);
    result.miscNoPrice.count += s.miscNoPrice.count;
    result.miscNoPrice.itemNames.push(...s.miscNoPrice.itemNames);
  }
  return result;
}

/** Format pricing status for display in summaries */
export function formatPricingStatusSummary(
  pricingStatus: PricingStatus,
): string | null {
  const parts: string[] = [];

  if (pricingStatus.missingPricing.count > 0) {
    parts.push(`no pricing for ${pricingStatus.missingPricing.count}`);
  }
  if (pricingStatus.miscNoPrice.count > 0) {
    parts.push(`${pricingStatus.miscNoPrice.count} misc`);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Same summary string as formatPricingStatusSummary, but from the bare counts
 * persisted on location.valuation (which omit item-name lists).
 */
export function formatPricingCountsSummary(
  counts: { missingPricing: number; miscNoPrice: number } | undefined | null,
): string | null {
  if (!counts) return null;
  const parts: string[] = [];
  if (counts.missingPricing > 0) {
    parts.push(`no pricing for ${counts.missingPricing}`);
  }
  if (counts.miscNoPrice > 0) {
    parts.push(`${counts.miscNoPrice} misc`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

type InventoryValuationResult = {
  totalValuation: number;
  breakdown: InventoryValuationBreakdown[];
  pricingStatus: PricingStatus;
};

/**
 * Calculate the total inventory valuation for a list of inventory items.
 * Uses the precomputed `valuation` column from each item (amount × product.price).
 * Groups a simple breakdown by product manufacturer (as a proxy for category).
 * Categorizes items by pricing status: priced, missingPricing, or miscNoPrice.
 *
 * This is a synchronous function - no WASM calls needed since valuations
 * are precomputed and stored in the database.
 */
export function calculateInventoryValuation(
  items: InventoryItem[],
): InventoryValuationResult {
  let totalValuation = 0;
  const pricingStatus = emptyPricingStatus();
  const byManufacturer = new Map<string, number>();

  for (const item of items) {
    const product = item.product;
    const valuation = item.valuation;

    const hasValuation = valuation != null && valuation > 0;

    if (hasValuation) {
      // Category: priced
      totalValuation += valuation;
      pricingStatus.priced.count++;
      pricingStatus.priced.itemNames.push(product.name);

      const key = product.manufacturer || "Unknown";
      byManufacturer.set(key, (byManufacturer.get(key) || 0) + valuation);
    } else if (isMiscProduct(product.name)) {
      // Category: misc - expected no price
      pricingStatus.miscNoPrice.count++;
      pricingStatus.miscNoPrice.itemNames.push(product.name);
    } else {
      // Category: missing pricing - unexpected
      pricingStatus.missingPricing.count++;
      pricingStatus.missingPricing.itemNames.push(product.name);
    }
  }

  const breakdown: InventoryValuationBreakdown[] = Array.from(byManufacturer)
    .map(([key, valuation]) => ({ key, label: key, valuation }))
    .sort((a, b) => b.valuation - a.valuation);

  return {
    totalValuation,
    breakdown,
    pricingStatus,
  };
}
