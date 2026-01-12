/**
 * Unit mapping handling functions for CSV import
 *
 * Handles price mappings and unit conversion mappings.
 */

import { eq } from "drizzle-orm";
import type { Amount } from "~/codec/codec";
import { getErrorMessage } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";
import type { ProductId } from "~/schemas/identifiers";
import {
  findPriceMapping,
  isMoneyUnit,
  truncateToTwoDecimals,
} from "~/schemas/price-mapping-utils";
import { parseUnitMappingString } from "~/schemas/unit-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { productUnitMappings } from "~/server/db/schema";
import { getDb, unwrapDb } from "~/server/repo/database-helpers";

/** Default currency unit when creating new price mappings */
const DEFAULT_CURRENCY = "dollar";

/**
 * Create or update a price mapping for a product (1 each <-> $X)
 * Handles price in either 'a' or 'b' position.
 *
 * Always normalizes to canonical format: 1 each <-> $X (a=each, b=price)
 * Preserves existing currency when updating, uses provided currency or defaults when creating.
 *
 * Accepts both Database and DrizzleTransaction for use within transactions.
 */
export const createOrUpdatePriceMapping = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
  price: Amount,
  source: string = "csv-import",
): Promise<void> => {
  const client = unwrapDb(db);
  const existingMappings = await client.query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = findPriceMapping(existingMappings);

  // Truncate price value to 2 decimals and use provided currency, or preserve existing, or default
  const truncatedValue = truncateToTwoDecimals(price.value);
  const currency =
    price.unit || existingPriceMapping?.price.unit || DEFAULT_CURRENCY;

  if (existingPriceMapping) {
    // Update existing, always normalize to canonical format
    await client
      .update(productUnitMappings)
      .set({
        a: { value: 1, unit: "each" },
        b: { value: truncatedValue, unit: currency },
        source,
      })
      .where(eq(productUnitMappings.id, existingPriceMapping.match.id));
  } else {
    // Create new price mapping in canonical format
    await client.insert(productUnitMappings).values({
      productId,
      a: { value: 1, unit: "each" },
      b: { value: truncatedValue, unit: currency },
      source,
    });
  }
};

/**
 * Sync unit mappings from a semicolon-separated string
 *
 * Parses format like "4 lb = $5; 1 cup = 120g"
 * Replaces existing non-canonical-price mappings with the new ones from the string.
 * Preserves the canonical price mapping (1 each = $X) which is handled separately
 * via the price column. Non-canonical price mappings like "2 oz = $8" are imported.
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

  // Find IDs of non-canonical-price mappings to delete
  // Keep ONLY the canonical price mapping (1 each = $X), delete everything else
  const nonCanonicalPriceMappingIds = existingMappings
    .filter((m) => {
      const isCanonicalPrice =
        (m.a.value === 1 && m.a.unit === "each" && isMoneyUnit(m.b.unit)) ||
        (m.b.value === 1 && m.b.unit === "each" && isMoneyUnit(m.a.unit));
      return !isCanonicalPrice; // Delete if NOT canonical price
    })
    .map((m) => m.id);

  // Delete existing non-canonical-price mappings
  for (const id of nonCanonicalPriceMappingIds) {
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
      const parsed = parseUnitMappingString(part);

      // Skip ONLY canonical price mappings (1 each = $X) - those are handled by price column
      // Non-canonical price mappings like "2 oz = $8" should be imported
      const isCanonicalPrice =
        (parsed.a.value === 1 &&
          parsed.a.unit === "each" &&
          isMoneyUnit(parsed.b.unit)) ||
        (parsed.b.value === 1 &&
          parsed.b.unit === "each" &&
          isMoneyUnit(parsed.a.unit));

      if (isCanonicalPrice) {
        continue; // Skip - handled by createOrUpdatePriceMapping
      }

      await getDb(db).insert(productUnitMappings).values({
        productId,
        a: parsed.a,
        b: parsed.b,
        source: parsed.source,
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

  const existingPriceMapping = findPriceMapping(existingMappings);

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
export const parseUnitMappingsForPreview = (
  mappingsStr: string,
): UnitMappingsPreviewResult => {
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const details: UnitMappingPreviewDetail[] = [];
  const errors: string[] = [];

  for (const part of mappingParts) {
    try {
      const parsed = parseUnitMappingString(part);
      details.push({
        from: wasm.format_amount(parsed.a),
        to: wasm.format_amount(parsed.b),
        source: parsed.source ?? undefined,
      });
    } catch (e) {
      errors.push(`"${part}": ${getErrorMessage(e)}`);
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
  const nonPriceMappings = existingMappings.filter(
    (m) => !isMoneyUnit(m.a.unit) && !isMoneyUnit(m.b.unit),
  );

  // Parse the incoming mappings string (filtering out price mappings)
  const parsedNew = parseUnitMappingsForPreview(newMappingsStr);
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
