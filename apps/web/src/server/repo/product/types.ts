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

type ProductSelect = Omit<typeof product.$inferSelect, "aliases"> & {
  aliases?: string[];
};
type LocationSelect = Omit<typeof location.$inferSelect, "aliases"> & {
  aliases?: string[];
};

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
};
