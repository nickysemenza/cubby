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
import { isMoneyUnit, isSingleEach } from "~/schemas/price-mapping-utils";
import { type Amount } from "~/codec/codec";

/** Default currency unit when creating new price mappings */
const DEFAULT_CURRENCY = "dollar";

interface PriceMappingMatch {
  id: string;
  /** The price amount (includes currency unit) */
  price: Amount;
}

/**
 * Find an existing price mapping (1 each <-> $X) in either direction.
 * Price can be in either 'a' or 'b' position.
 * Returns the price Amount (the side with money).
 */
const findPriceMapping = async (
  mappings: Array<{ id: string; a: Amount; b: Amount }>,
): Promise<PriceMappingMatch | null> => {
  for (const m of mappings) {
    // Check if b is money and a is "1 each"
    if (isSingleEach(m.a) && (await isMoneyUnit(m.b.unit))) {
      return { id: m.id, price: m.b };
    }
    // Check if a is money and b is "1 each"
    if (isSingleEach(m.b) && (await isMoneyUnit(m.a.unit))) {
      return { id: m.id, price: m.a };
    }
  }
  return null;
};

/**
 * Create or update a price mapping for a product (1 each <-> $X)
 * Handles price in either 'a' or 'b' position.
 *
 * Always normalizes to canonical format: 1 each <-> $X (a=each, b=price)
 * Preserves existing currency when updating, uses provided currency or defaults when creating.
 */
export const createOrUpdatePriceMapping = async (
  db: Database,
  productId: ProductId,
  price: Amount,
  source: string = "csv-import",
): Promise<void> => {
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = await findPriceMapping(existingMappings);

  // Use provided currency, or preserve existing, or default
  const currency =
    price.unit || existingPriceMapping?.price.unit || DEFAULT_CURRENCY;

  if (existingPriceMapping) {
    // Update existing, always normalize to canonical format
    await getDb(db)
      .update(productUnitMappings)
      .set({
        a: { value: 1, unit: "each" },
        b: { value: price.value, unit: currency },
        source,
      })
      .where(eq(productUnitMappings.id, existingPriceMapping.id));
  } else {
    // Create new price mapping in canonical format
    await getDb(db)
      .insert(productUnitMappings)
      .values({
        productId,
        a: { value: 1, unit: "each" },
        b: { value: price.value, unit: currency },
        source,
      });
  }
};

/**
 * Sync unit mappings from a semicolon-separated string
 *
 * Parses format like "4 lb = $5; 1 cup = 120g"
 * Replaces existing non-price mappings with the new ones from the string.
 */
export const createUnitMappingsFromString = async (
  db: Database,
  productId: ProductId,
  mappingsStr: string,
): Promise<void> => {
  // First, get existing mappings to identify and preserve price mappings
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  // Find IDs of non-price mappings to delete
  const nonPriceMappingIds: string[] = [];
  for (const m of existingMappings) {
    const aIsMoney = await isMoneyUnit(m.a.unit);
    const bIsMoney = await isMoneyUnit(m.b.unit);
    if (!aIsMoney && !bIsMoney) {
      nonPriceMappingIds.push(m.id);
    }
  }

  // Delete existing non-price mappings
  for (const id of nonPriceMappingIds) {
    await getDb(db)
      .delete(productUnitMappings)
      .where(eq(productUnitMappings.id, id));
  }

  // Parse and insert new mappings
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of mappingParts) {
    try {
      const parsed = await parseUnitMappingString(part);
      // Skip price mappings (those are handled separately)
      const aIsMoney = await isMoneyUnit(parsed.a.unit);
      const bIsMoney = await isMoneyUnit(parsed.b.unit);
      if (aIsMoney || bIsMoney) {
        continue;
      }
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
 * Handles price in either 'a' or 'b' position.
 *
 * Returns the new price value if it would be set or changed, undefined otherwise.
 * (Returns just the numeric value for preview display purposes)
 */
export const checkPriceMappingChanges = async (
  db: Database,
  productId: ProductId,
  newPrice: Amount,
): Promise<number | undefined> => {
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = await findPriceMapping(existingMappings);

  // Return the new price value if it would be set or changed
  if (
    !existingPriceMapping ||
    existingPriceMapping.price.value !== newPrice.value
  ) {
    return newPrice.value;
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
