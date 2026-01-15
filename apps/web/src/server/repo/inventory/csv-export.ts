import dayjs from "dayjs";
import { and, eq, notInArray } from "drizzle-orm";
import { joinImageUrls } from "~/lib/image-utils";
import {
  inventoryId as inventoryIdSchema,
  type LocationId,
  locationId as locationIdSchema,
  productId as productIdSchema,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "~/schemas/identifiers";
import {
  extractPriceFromMappings,
  serializeUnitMappings,
} from "~/schemas/price-mapping-utils";
import type { ProductCategory } from "~/schemas/product";
import type { Database } from "~/server/db";
import { inventoryEntry, product } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { SYNC_TIMESTAMPS } from "~/server/repo/sync/config";
import type { InventoryCSVExportRow, ProductExportFields } from "./types";

/** Format a date for CSV/Sheets export */
function formatTimestamp(date: Date | null): string | null {
  if (!date) return null;
  return dayjs(date).format("YYYY-MM-DD HH:mm:ss");
}

/**
 * Build common product export fields from a product with unit mappings and ingredient
 */
function buildProductExportFields(p: ProductExportFields): {
  product_shortcode: ReturnType<typeof unsafeProductShortcode> | null;
  product_name: string;
  manufacturer: string;
  category: ProductCategory | null;
  upc: string;
  model: string | null;
  ndb_number: number | null;
  expected_qty: number | null;
  price: number | null;
  unit_mappings: string | null;
  ingredient_name: string | null;
  aliases: string | null;
  notes: string | null;
  product_image: string | null;
  product_created_at?: string | null;
  product_updated_at?: string | null;
} {
  // Extract price from unit mappings (source of truth, as denormalized price may be stale)
  const priceAmount = extractPriceFromMappings(p.unitMappings);
  return {
    product_shortcode: p.shortcode ? unsafeProductShortcode(p.shortcode) : null,
    product_name: p.name,
    manufacturer: p.manufacturer,
    category: p.category,
    upc: p.upc ?? "",
    model: p.model ?? null,
    ndb_number: p.ndb_number ?? null,
    expected_qty: p.expectedQuantity,
    price: priceAmount?.value ?? null,
    unit_mappings: serializeUnitMappings(p.unitMappings),
    ingredient_name: p.Ingredient?.name ?? null,
    aliases: p.Ingredient?.aliases?.join("; ") ?? null,
    notes: p.notes ?? null,
    product_image: joinImageUrls(p.images),
    // Timestamps (only if feature flag enabled)
    ...(SYNC_TIMESTAMPS && {
      product_created_at: formatTimestamp(p.createdAt),
      product_updated_at: formatTimestamp(p.updatedAt),
    }),
  };
}

export const exportInventoryToCSV = async (
  db: Database,
  locationIdFilter?: LocationId,
): Promise<InventoryCSVExportRow[]> => {
  // Build where conditions for inventory entries (always exclude soft-deleted)
  const conditions: ReturnType<typeof eq>[] = [notDeleted(inventoryEntry)];

  if (locationIdFilter) {
    conditions.push(eq(inventoryEntry.locationId, locationIdFilter));
  }

  const whereClause = and(...conditions);

  // Fetch all inventory entries with their product (including unit mappings and ingredient) and location
  const entries = await getDb(db).query.inventoryEntry.findMany({
    where: whereClause,
    with: {
      Product: {
        with: {
          unitMappings: true,
          Ingredient: true,
          images: {
            with: { image: true },
          },
        },
      },
      location: true,
    },
  });

  // Convert inventory entries to export rows
  const inventoryRows = entries.map((entry) => {
    const parsedAmount = parseInventoryAmount(entry.amount, entry.id);
    const productFields = buildProductExportFields({
      ...entry.Product,
      createdAt: entry.Product.createdAt,
      updatedAt: entry.Product.updatedAt,
    });
    return {
      ...productFields,
      location_shortcode: entry.location.shortcode
        ? unsafeLocationShortcode(entry.location.shortcode)
        : null,
      location_name: entry.location.name,
      location_id: locationIdSchema.parse(entry.locationId),
      inventory_entry_id: inventoryIdSchema.parse(entry.id),
      product_id: productIdSchema.parse(entry.productId),
      quantity: parsedAmount.value,
      unit: parsedAmount.unit,
      // Inventory timestamps (only if feature flag enabled)
      ...(SYNC_TIMESTAMPS && {
        inventory_created_at: formatTimestamp(entry.createdAt),
        inventory_updated_at: formatTimestamp(entry.updatedAt),
      }),
    };
  });

  // When filtering by location, only return inventory rows (not product-only)
  if (locationIdFilter) {
    return inventoryRows;
  }

  // Collect product IDs that have inventory entries
  const productIdsWithInventory = entries.map((e) => e.productId);

  // Fetch products without any inventory entries (excludes soft-deleted)
  const productsWithoutInventory = await getDb(db).query.product.findMany({
    where: and(
      notDeleted(product),
      productIdsWithInventory.length > 0
        ? notInArray(product.id, productIdsWithInventory)
        : undefined,
    ),
    with: {
      unitMappings: true,
      Ingredient: true,
      images: {
        with: { image: true },
        limit: 1,
      },
    },
  });

  // Convert products without inventory to export rows (product-only rows)
  const productOnlyRows = productsWithoutInventory.map((p) => {
    const productFields = buildProductExportFields({
      ...p,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
    return {
      ...productFields,
      location_shortcode: null, // No location for product-only rows
      location_name: "", // Empty for product-only rows
      location_id: null, // No location for product-only rows
      inventory_entry_id: null, // No inventory entry for product-only rows
      product_id: productIdSchema.parse(p.id),
      quantity: null, // No inventory
      unit: null, // No inventory
      // No inventory timestamps for product-only rows
      ...(SYNC_TIMESTAMPS && {
        inventory_created_at: null,
        inventory_updated_at: null,
      }),
    };
  });

  return [...inventoryRows, ...productOnlyRows];
};
