import { type z } from "zod";
import {
  inventoryEntry,
  product,
  location,
  productUnitMappings,
  image,
} from "~/server/db/schema";
import { type Amount } from "~/codec/codec";
import { type ProductId, type LocationId } from "~/schemas/identifiers";

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
  amount?: z.infer<typeof import("~/codec/codec").amount>;
  productId?: ProductId;
  locationId?: LocationId;
}

export interface CreateInventoryEntryData {
  amount: z.infer<typeof import("~/codec/codec").amount>;
  productId: ProductId;
  locationId: LocationId;
}

export interface InventoryCSVExportRow {
  product_name: string;
  manufacturer: string;
  upc: string;
  model: string | null;
  ndb_number: number | null;
  location_path: string; // empty string for product-only rows
  location_id: LocationId | null; // null for product-only rows
  quantity: number | null; // null for product-only rows
  unit: string | null; // null for product-only rows
  expected_qty: number | null;
  price: number | null;
  unit_mappings: string | null;
  ingredient_name: string | null;
  aliases: string | null;
}

// Re-export Amount for convenience
export type { Amount };
