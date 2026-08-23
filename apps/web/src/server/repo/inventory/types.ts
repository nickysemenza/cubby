import type { Amount } from "@cubby/schemas/codec";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import type {
  inventoryEntry,
  location,
  product,
  productUnitMappings,
} from "~/server/db/schema";
import type {
  MappableImageRecord,
  RowWithOptionalAliases,
  RowWithOptionalAliasesAndTags,
} from "~/server/repo/database-helpers";
import type { LocationIdentityProductRow } from "~/server/repo/location/internal-types";
import type { MappableProductExternalId } from "~/server/repo/product/external-id-types";

type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect>;
type LocationSelect = RowWithOptionalAliasesAndTags<
  typeof location.$inferSelect
>;

export type InventoryEntryDeepDB = typeof inventoryEntry.$inferSelect & {
  product: ProductSelect & {
    unitMappings: Array<typeof productUnitMappings.$inferSelect>;
    externalIds: MappableProductExternalId[];
    images: Array<{
      image: MappableImageRecord;
    }>;
  };
  location: LocationSelect & {
    // The holding location's own identity SKU, so a stock row can render the
    // bin it sits in without a second fetch.
    product?: LocationIdentityProductRow | null;
    images: Array<{
      image: MappableImageRecord;
    }>;
  };
};

export type InventoryEntryListDB = typeof inventoryEntry.$inferSelect & {
  product: ProductSelect & {
    externalIds?: MappableProductExternalId[];
  };
  location: LocationSelect;
};

export interface UpdateInventoryEntryData {
  amount?: Amount;
  productId?: ProductId;
  locationId?: LocationId;
  placement?: InventoryPlacement;
}

export interface CreateInventoryEntryData {
  amount: Amount;
  productId: ProductId;
  locationId: LocationId;
  placement?: InventoryPlacement;
  /**
   * Stamp the row as observed at creation. Only a location sweep sets this: it
   * put the row there by looking at the object, so leaving `verifiedAt` null
   * would make a just-scanned shelf read as never audited.
   */
  verifiedAt?: Date | null;
}
