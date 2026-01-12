import type { z } from "zod";
import type { Amount } from "~/codec/codec";
import type {
  InventoryId,
  LocationId,
  LocationShortcode,
  ProductId,
  ProductShortcode,
} from "~/schemas/identifiers";
import type { ProductCategory } from "~/schemas/product";
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
  product_shortcode: ProductShortcode | null; // Human-readable shortcode (P-XXXX)
  product_name: string;
  manufacturer: string;
  category: ProductCategory | null;
  upc: string;
  model: string | null;
  ndb_number: number | null;
  location_shortcode: LocationShortcode | null; // Human-readable shortcode (L-XXXX)
  location_name: string; // empty string for product-only rows
  location_id: LocationId | null; // null for product-only rows
  inventory_entry_id: InventoryId | null; // null for product-only rows (used for deletion)
  product_id: ProductId; // used for deletion lookup
  quantity: number | null; // null for product-only rows
  unit: string | null; // null for product-only rows
  expected_qty: number | null;
  price: number | null;
  unit_mappings: string | null;
  ingredient_name: string | null;
  aliases: string | null;
  notes: string | null;
  product_image: string | null;
  // Timestamps (optional, controlled by SYNC_TIMESTAMPS flag)
  product_created_at?: string | null;
  product_updated_at?: string | null;
  inventory_created_at?: string | null;
  inventory_updated_at?: string | null;
}

/**
 * Product with related data needed for CSV export field building
 */
export interface ProductExportFields {
  shortcode: string | null; // Human-readable shortcode (P-XXXX)
  name: string;
  manufacturer: string;
  category: ProductCategory | null;
  upc: string | null;
  model: string | null;
  ndb_number: number | null;
  expectedQuantity: number | null;
  price: number | null;
  unitMappings: Array<{ a: Amount; b: Amount; source: string | null }>;
  Ingredient: { name: string; aliases: string[] } | null;
  notes: string | null;
  images: Array<{ image: { url: string } }>;
  // Timestamps (for SYNC_TIMESTAMPS feature)
  createdAt: Date | null;
  updatedAt: Date | null;
}
