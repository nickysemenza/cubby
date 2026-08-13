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
} from "~/server/repo/database-helpers";
import type { MappableProductExternalId } from "~/server/repo/product/external-id-types";

type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect>;
type LocationSelect = RowWithOptionalAliases<typeof location.$inferSelect>;

export type InventoryEntryDeepDB = typeof inventoryEntry.$inferSelect & {
  product: ProductSelect & {
    unitMappings: Array<typeof productUnitMappings.$inferSelect>;
    externalIds: MappableProductExternalId[];
    images: Array<{
      image: MappableImageRecord;
    }>;
  };
  location: LocationSelect & {
    images: Array<{
      image: MappableImageRecord;
    }>;
  };
};

export type InventoryEntryListDB = typeof inventoryEntry.$inferSelect & {
  product: ProductSelect;
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
}
