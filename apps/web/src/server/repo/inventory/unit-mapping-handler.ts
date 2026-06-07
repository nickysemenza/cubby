/**
 * Price mapping handling for products (canonical: 1 each <-> $X).
 *
 * Used by product quick-create.
 */

import type { Amount } from "@cubby/schemas/codec";
import type { ProductId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import {
  findPriceMapping,
  truncateToTwoDecimals,
} from "~/lib/price-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { productUnitMappings } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";

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
  source: string = "manual",
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
