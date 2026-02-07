import type { Amount } from "@cubby/schemas/codec";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import type {
  image,
  inventoryEntry,
  location,
  product,
  productUnitMappings,
} from "~/server/db/schema";

export type InventoryEntryDeepDB = typeof inventoryEntry.$inferSelect & {
  Product: typeof product.$inferSelect & {
    unitMappings: Array<typeof productUnitMappings.$inferSelect>;
    images: Array<{
      image: typeof image.$inferSelect;
    }>;
  };
  location: typeof location.$inferSelect & {
    images: Array<{
      image: typeof image.$inferSelect;
    }>;
  };
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
