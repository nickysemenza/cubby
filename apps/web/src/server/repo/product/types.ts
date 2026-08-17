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
import type { LocationIdentityProductRow } from "~/server/repo/location/internal-types";
import type { MappableProductExternalId } from "./external-id-types";
import type { ProductPricing } from "./pricing";
import type { QuantityLedger } from "./quantity-ledger";

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
        // The holding location's own identity SKU — the bin itself, not this
        // product's stock in it.
        product?: LocationIdentityProductRow | null;
        images: Array<{
          image: MappableImageRecord;
          deletedAt?: Date | null;
        }>;
      };
    }
  >;
  /** Locations that ARE this product; scalar columns only. */
  locations?: Array<typeof location.$inferSelect>;
  images: Array<{
    image: MappableImageRecord;
    deletedAt?: Date | null;
  }>;
  /** Attached by `enrichProductRowsWithQuantityLedger`, same as the list shape. */
  quantityLedger: QuantityLedger;
};

export type ProductListDB = ProductSelect & {
  pricing?: ProductPricing;
  dataQuality: DataQuality;
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
  /** Latest live Purchase date across the Product's live Expense lines. */
  purchaseDate: string | null;
  /**
   * Units bought minus units gone. Attached by `loadProductQuantityLedgers`
   * after the row loads, not an `extras` scalar — see the note at its call
   * site in crud.ts.
   */
  quantityLedger: QuantityLedger;
};
