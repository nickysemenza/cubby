import { getAllUnitMappingsFromProduct } from "~/schemas/unit-mapping-utils";
import { convertAmountToPrice } from "~/app/_components/units/univ-conversion";
import { type z } from "zod";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";

export type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

export type InventoryValueBreakdown = {
  key: string;
  label: string;
  value: number;
};

export type InventoryValueResult = {
  totalValue: number;
  breakdown: InventoryValueBreakdown[];
  missingPriceItemNames: string[];
};

/**
 * Calculate the total inventory value for a list of inventory items.
 * Uses WASM unit mappings to convert each item's amount into a money value.
 * Groups a simple breakdown by product manufacturer (as a proxy for category).
 */
export async function calculateInventoryValue(
  items: InventoryItem[],
): Promise<InventoryValueResult> {
  let totalValue = 0;
  const missingPriceItemNames: string[] = [];

  const byManufacturer = new Map<string, number>();

  for (const item of items) {
    const product = item.product;
    const mappings = await getAllUnitMappingsFromProduct(product);

    const priceRes = convertAmountToPrice(item.amount, mappings);
    if (priceRes.success) {
      const val = priceRes.value.value || 0;
      totalValue += val;
      const key = product.manufacturer || "Unknown";
      byManufacturer.set(key, (byManufacturer.get(key) || 0) + val);
    } else {
      // Use product name as a human-friendly identifier
      missingPriceItemNames.push(product.name);
    }
  }

  const breakdown: InventoryValueBreakdown[] = Array.from(byManufacturer)
    .map(([key, value]) => ({ key, label: key, value }))
    .sort((a, b) => b.value - a.value);

  return {
    totalValue,
    breakdown,
    missingPriceItemNames,
  };
}
