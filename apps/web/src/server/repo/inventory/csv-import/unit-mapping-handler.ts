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

/**
 * Parse unit mappings string and return count + details (for preview)
 */
export const parseUnitMappingsForPreview = (
  mappingsStr: string,
): { count: number; details: Array<{ from: string; to: string }> } => {
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const details = mappingParts.map((part) => {
    // Parse "1 stick = 113.4g" format
    const [from, to] = part.split("=").map((s) => s.trim());
    return { from: from ?? part, to: to ?? "" };
  });

  return { count: mappingParts.length, details };
};
