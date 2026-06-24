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

/**
 * Type for deeply nested product query results.
 * Used when fetching products with full relations.
 */
export type ProductDeepDB = typeof product.$inferSelect & {
  ingredient: typeof ingredient.$inferSelect | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  externalIds: Array<typeof productExternalId.$inferSelect>;
  inventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: typeof location.$inferSelect & {
        images: Array<{
          image: typeof image.$inferSelect;
        }>;
      };
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
  }>;
};
