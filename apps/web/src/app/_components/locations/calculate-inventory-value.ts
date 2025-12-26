import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { convertAmountToPrice } from "~/app/_components/units/univ-conversion";
import { type z } from "zod";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { isMiscProduct } from "~/lib/constants";

export type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

type InventoryValueBreakdown = {
  key: string;
  label: string;
  value: number;
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

export type InventoryValueResult = {
  totalValue: number;
  breakdown: InventoryValueBreakdown[];
  pricingStatus: PricingStatus;
};

/**
 * Calculate the total inventory value for a list of inventory items.
 * Uses WASM unit mappings to convert each item's amount into a money value.
 * Groups a simple breakdown by product manufacturer (as a proxy for category).
 * Categorizes items by pricing status: priced, missingPricing, or miscNoPrice.
 */
export async function calculateInventoryValue(
  items: InventoryItem[],
): Promise<InventoryValueResult> {
  let totalValue = 0;
  const pricingStatus = emptyPricingStatus();
  const byManufacturer = new Map<string, number>();

  for (const item of items) {
    const product = item.product;
    const mappings = await getAllUnitMappingsFromProduct(product);
    const priceRes = convertAmountToPrice(item.amount, mappings);

    const hasValue =
      priceRes.success && priceRes.value.value && priceRes.value.value > 0;

    if (hasValue) {
      // Category: priced
      const val = priceRes.value.value!;
      totalValue += val;
      pricingStatus.priced.count++;
      pricingStatus.priced.itemNames.push(product.name);

      const key = product.manufacturer || "Unknown";
      byManufacturer.set(key, (byManufacturer.get(key) || 0) + val);
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

  const breakdown: InventoryValueBreakdown[] = Array.from(byManufacturer)
    .map(([key, value]) => ({ key, label: key, value }))
    .sort((a, b) => b.value - a.value);

  return {
    totalValue,
    breakdown,
    pricingStatus,
  };
}
