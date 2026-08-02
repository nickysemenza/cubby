/**
 * Product repository type definitions.
 */

import type { DataQuality } from "@cubby/schemas/data-quality";
import type {
  ingredient,
  inventoryEntry,
  location,
  product,
  productUnitMappings,
} from "~/server/db/schema";
import type {
  MappableImageRecord,
  RowWithOptionalAliases,
} from "~/server/repo/database-helpers";
import type { MappableProductExternalId } from "./external-id-types";
import type { ProductPricing } from "./pricing";

type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect>;
type LocationSelect = RowWithOptionalAliases<typeof location.$inferSelect>;

/**
 * Type for deeply nested product query results.
 * Used when fetching products with full relations.
 */
export type ProductDeepDB = ProductSelect & {
  pricing?: ProductPricing;
  ingredient: typeof ingredient.$inferSelect | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  externalIds: MappableProductExternalId[];
  inventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: LocationSelect & {
        images: Array<{
          image: MappableImageRecord;
          deletedAt?: Date | null;
        }>;
      };
    }
  >;
  images: Array<{
    image: MappableImageRecord;
    deletedAt?: Date | null;
  }>;
};

export type ProductListDB = ProductSelect & {
  pricing?: ProductPricing;
  dataQuality?: DataQuality;
  ingredient: typeof ingredient.$inferSelect | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  externalIds: MappableProductExternalId[];
  inventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: LocationSelect;
    }
  >;
  images: Array<{
    image: MappableImageRecord;
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
