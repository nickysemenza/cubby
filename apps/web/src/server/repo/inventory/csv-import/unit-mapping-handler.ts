/**
 * Unit mapping handling functions for CSV import
 *
 * Handles price mappings and unit conversion mappings.
 */

import type { Database } from "~/server/db";
import type { ProductId } from "~/schemas/identifiers";
import { getDb } from "~/server/repo/database-helpers";
import { productUnitMappings } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { parseUnitMappingString } from "~/schemas/unitmapping";
import { wasmServer } from "~/lib/wasm";
import { isMoneyUnit, findPriceMapping } from "~/schemas/price-mapping-utils";
import type { Amount } from "~/codec/codec";

/** Default currency unit when creating new price mappings */
const DEFAULT_CURRENCY = "dollar";

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
      .where(eq(productUnitMappings.id, existingPriceMapping.match.id));
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

interface UnitMappingPreviewDetail {
  from: string;
  to: string;
  source?: string;
  error?: string;
}

interface UnitMappingsPreviewResult {
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

/**
 * Check if unit mappings would change (for preview)
 *
 * Compares the incoming unit mappings string against the product's existing mappings.
 * Returns preview result only if there are actual changes, null otherwise.
 */
export const checkUnitMappingsChanges = async (
  db: Database,
  productId: ProductId,
  newMappingsStr: string,
): Promise<{
  willBeAdded: number;
  details: UnitMappingPreviewDetail[];
  current: string | null;
} | null> => {
  // Get existing unit mappings for this product
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  // Filter to non-price mappings (same logic as serializeUnitMappings)
  const nonPriceResults = await Promise.all(
    existingMappings.map(async (m) => ({
      ...m,
      isMoneyA: await isMoneyUnit(m.a.unit),
      isMoneyB: await isMoneyUnit(m.b.unit),
    })),
  );
  const nonPriceMappings = nonPriceResults.filter(
    (m) => !m.isMoneyA && !m.isMoneyB,
  );

  // Parse the incoming mappings string (filtering out price mappings)
  const parsedNew = await parseUnitMappingsForPreview(newMappingsStr);
  const newNonPriceMappings = parsedNew.details.filter((d) => {
    // Check if either side looks like money (simplified check for preview)
    const looksLikeMoney = (s: string) =>
      s.includes("$") || s.toLowerCase().includes("dollar");
    return !looksLikeMoney(d.from) && !looksLikeMoney(d.to);
  });

  // Serialize existing mappings for comparison (without source for comparison purposes)
  const formatNum = (n: number) => {
    const rounded = Math.round(n * 1000000) / 1000000;
    return rounded.toString();
  };

  // Normalize for comparison (lowercase, trim spaces, remove source annotations)
  const normalizeForCompare = (s: string) =>
    s
      .toLowerCase()
      .replace(/ @ [^;]+/g, "") // Remove source annotations like " @ test"
      .replace(/\s+/g, " ")
      .trim();

  // Serialize existing without source for comparison
  const existingForCompare =
    nonPriceMappings.length > 0
      ? nonPriceMappings
          .map(
            (m) =>
              `${formatNum(m.a.value)} ${m.a.unit} = ${formatNum(m.b.value)} ${m.b.unit}`,
          )
          .join("; ")
      : null;

  // Serialize with source for display purposes
  const existingSerialized =
    nonPriceMappings.length > 0
      ? nonPriceMappings
          .map((m) => {
            const sourceStr = m.source ? ` @ ${m.source}` : "";
            return `${formatNum(m.a.value)} ${m.a.unit} = ${formatNum(m.b.value)} ${m.b.unit}${sourceStr}`;
          })
          .join("; ")
      : null;

  // Compare counts - if same number of mappings, check if they're equivalent
  if (nonPriceMappings.length === newNonPriceMappings.length) {
    // Simple check: if counts match and we have existing, likely no change
    // (A more robust check would compare parsed values, but this handles most cases)
    if (newNonPriceMappings.length === 0) {
      return null; // Both have no non-price mappings
    }
    // Compare serialized versions (normalized format, without source)
    const newForCompare = newNonPriceMappings
      .map((d) => `${d.from} = ${d.to}`)
      .join("; ");

    if (
      existingForCompare &&
      normalizeForCompare(existingForCompare) ===
        normalizeForCompare(newForCompare)
    ) {
      return null; // No changes
    }
  }

  // There are changes
  if (newNonPriceMappings.length === 0) {
    return null; // No new mappings to add
  }

  return {
    willBeAdded: newNonPriceMappings.length,
    details: newNonPriceMappings,
    current: existingSerialized,
  };
};
