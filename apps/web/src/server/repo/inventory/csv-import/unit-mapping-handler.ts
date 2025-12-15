/**
 * Unit mapping handling functions for CSV import
 *
 * Handles price mappings and unit conversion mappings.
 */

import { type Database } from "~/server/db";
import { type ProductId } from "~/schemas/identifiers";
import { getDb } from "~/server/repo/database-helpers";
import { productUnitMappings } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { parseUnitMappingString } from "~/schemas/unitmapping";
import { wasmServer } from "~/lib/wasm";

/**
 * Create or update a price mapping for a product (1 each -> $X)
 */
export const createOrUpdatePriceMapping = async (
  db: Database,
  productId: ProductId,
  price: number,
  source: string = "csv-import",
): Promise<void> => {
  // Check if a price mapping already exists (1 each -> $X)
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = existingMappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && m.b.unit === "dollar",
  );

  if (existingPriceMapping) {
    // Update existing price mapping
    await getDb(db)
      .update(productUnitMappings)
      .set({ b: { value: price, unit: "dollar" }, source })
      .where(eq(productUnitMappings.id, existingPriceMapping.id));
  } else {
    // Create new price mapping
    await getDb(db)
      .insert(productUnitMappings)
      .values({
        productId,
        a: { value: 1, unit: "each" },
        b: { value: price, unit: "dollar" },
        source,
      });
  }
};

/**
 * Create unit mappings from a semicolon-separated string
 *
 * Parses format like "4 lb = $5; 1 cup = 120g"
 */
export const createUnitMappingsFromString = async (
  db: Database,
  productId: ProductId,
  mappingsStr: string,
): Promise<void> => {
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of mappingParts) {
    try {
      const parsed = await parseUnitMappingString(part);
      await getDb(db)
        .insert(productUnitMappings)
        .values({
          productId,
          a: parsed.a,
          b: parsed.b,
          source: parsed.source ?? "csv-import",
        });
    } catch (e) {
      // Log warning but continue with other mappings
      console.warn(`Failed to parse unit mapping: ${part}`, e);
    }
  }
};

/**
 * Check what price mapping changes would occur (for preview)
 *
 * Returns the new price if it would be set or changed, undefined otherwise.
 */
export const checkPriceMappingChanges = async (
  db: Database,
  productId: ProductId,
  newPrice: number,
): Promise<number | undefined> => {
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = existingMappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && m.b.unit === "dollar",
  );

  // Return the new price if it would be set or changed
  if (!existingPriceMapping || existingPriceMapping.b.value !== newPrice) {
    return newPrice;
  }
  return undefined;
};

export interface UnitMappingPreviewDetail {
  from: string;
  to: string;
  source?: string;
  error?: string;
}

export interface UnitMappingsPreviewResult {
  count: number;
  details: UnitMappingPreviewDetail[];
  errors: string[];
}

/**
 * Parse unit mappings string using WASM and return count + formatted details (for preview)
 *
 * All parsing is done via WASM to properly handle all formats:
 * - "4 lb = $5" (conversion format)
 * - "$5/4lb" (price-per format)
 * - "4 lb = $5 @ costco" (with source)
 *
 * Invalid mappings are collected as errors rather than silently falling back.
 */
export const parseUnitMappingsForPreview = async (
  mappingsStr: string,
): Promise<UnitMappingsPreviewResult> => {
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const details: UnitMappingPreviewDetail[] = [];
  const errors: string[] = [];

  for (const part of mappingParts) {
    try {
      const parsed = await parseUnitMappingString(part);
      const fromFormatted = await wasmServer.format_amount(parsed.a);
      const toFormatted = await wasmServer.format_amount(parsed.b);
      details.push({
        from: fromFormatted,
        to: toFormatted,
        source: parsed.source ?? undefined,
      });
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Invalid unit mapping format";
      errors.push(`"${part}": ${errorMsg}`);
    }
  }

  return { count: details.length, details, errors };
};
