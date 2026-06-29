import type { Amount } from "@cubby/schemas/codec";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import type {
  image,
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

export type InventoryEntryDeepDB = typeof inventoryEntry.$inferSelect & {
  product: ProductSelect & {
    unitMappings: Array<typeof productUnitMappings.$inferSelect>;
    externalIds: Array<typeof productExternalId.$inferSelect>;
    images: Array<{
      image: typeof image.$inferSelect;
    }>;
  };
  location: LocationSelect & {
    images: Array<{
      image: typeof image.$inferSelect;
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
}

export interface CreateInventoryEntryData {
  amount: Amount;
  productId: ProductId;
  locationId: LocationId;
}
