/**
 * Product repository type definitions.
 */

import type {
  image,
  ingredient,
  inventoryEntry,
  location,
  product,
  productExternalId,
  productUnitMappings,
} from "~/server/db/schema";
import type { RowWithOptionalAliases } from "~/server/repo/database-helpers";

type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect>;
type LocationSelect = RowWithOptionalAliases<typeof location.$inferSelect>;

/**
 * Type for deeply nested product query results.
 * Used when fetching products with full relations.
 */
export type ProductDeepDB = ProductSelect & {
  ingredient: typeof ingredient.$inferSelect | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  externalIds: Array<typeof productExternalId.$inferSelect>;
  inventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: LocationSelect & {
        images: Array<{
          image: typeof image.$inferSelect;
          deletedAt?: Date | null;
        }>;
      };
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
    deletedAt?: Date | null;
  }>;
};

export type ProductListDB = ProductSelect & {
  ingredient: typeof ingredient.$inferSelect | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  externalIds: Array<typeof productExternalId.$inferSelect>;
  inventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: LocationSelect;
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
    deletedAt?: Date | null;
  }>;
  // Scalar extras from `relations.product.list.extras` — count() returns
  // bigint, which comes back as a string over the wire, hence the union.
  expenseCount: number | string;
  // `::double precision` cast in the extras SQL comes back as a plain
  // number (unlike the bigint count() above), but the mapper still coerces
  // with Number() defensively — same as `purchaseExpenseTotal` in
  // repo/purchase.ts.
  expenseTotal: number;
};
