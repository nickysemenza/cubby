import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { isMiscProduct } from "@cubby/shared";
import type { z } from "zod";

export type InventoryItem = z.infer<typeof inventoryListItemOut>;

type InventoryValuationBreakdown = {
  key: string;
  label: string;
  valuation: number;
};

type PricingCategorySummary = {
  count: number;
  itemNames: string[];
};

export type PricingStatus = {
  priced: PricingCategorySummary;
  missingPricing: PricingCategorySummary;
  miscNoPrice: PricingCategorySummary;
};

export function emptyPricingStatus(): PricingStatus {
  return {
    priced: { count: 0, itemNames: [] },
    missingPricing: { count: 0, itemNames: [] },
    miscNoPrice: { count: 0, itemNames: [] },
  };
}

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

export function calculateInventoryValuation(
  items: InventoryItem[],
): InventoryValuationResult {
  let totalValuation = 0;
  const pricingStatus = emptyPricingStatus();
  const byManufacturer = new Map<string, number>();

  for (const item of items) {
    const product = item.product;
    const valuation = item.valuation;

    // Priced means "somebody set a price", not "worth something". A valuation
    // is null when the entry's amount has no path to money (see
    // computeInventoryValuation) — which is usually "no price set", but can
    // also be a priced Product whose unit can't reach the money edge. So
    // `!= null` is the faithful test — and an explicit $0 (bundled freebies) is
    // a real answer that shouldn't keep nagging as unpriced. Adding 0 to the
    // total is a no-op either way. This bucket lumps the two null causes
    // together; `findInventoryWithoutPricePath` separates the second.
    const hasValuation = valuation != null;

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
