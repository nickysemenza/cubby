import dayjs from "dayjs";
import { and, eq, notInArray } from "drizzle-orm";
import { joinImageUrls } from "~/lib/image-utils";
import {
  inventoryId as inventoryIdSchema,
  type LocationId,
  locationId as locationIdSchema,
  type OrganizationId,
  productId as productIdSchema,
} from "~/schemas/identifiers";
import {
  extractPriceFromMappings,
  serializeUnitMappings,
} from "~/schemas/price-mapping-utils";
import type { ProductCategory } from "~/schemas/product";
import type { Database } from "~/server/db";
import { inventoryEntry, product } from "~/server/db/schema";
import { getDb, parseInventoryAmount } from "~/server/repo/database-helpers";
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
  product_image: string | null;
  product_created_at?: string | null;
  product_updated_at?: string | null;
} {
  // Extract price from unit mappings (source of truth, as denormalized price may be stale)
  const priceAmount = extractPriceFromMappings(p.unitMappings);
  return {
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
  organizationId: OrganizationId,
  locationIdFilter?: LocationId,
): Promise<InventoryCSVExportRow[]> => {
  // Build where conditions for inventory entries
  const conditions = [eq(inventoryEntry.organizationId, organizationId)];

  if (locationIdFilter) {
    conditions.push(eq(inventoryEntry.locationId, locationIdFilter));
  }

  // Fetch all inventory entries with their product (including unit mappings and ingredient) and location
  const entries = await getDb(db).query.inventoryEntry.findMany({
    where: and(...conditions),
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
  const inventoryRows = await Promise.all(
    entries.map(async (entry) => {
      const parsedAmount = parseInventoryAmount(entry.amount, entry.id);
      const productFields = buildProductExportFields({
        ...entry.Product,
        createdAt: entry.Product.createdAt,
        updatedAt: entry.Product.updatedAt,
      });
      return {
        ...productFields,
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
    }),
  );

  // When filtering by location, only return inventory rows (not product-only)
  if (locationIdFilter) {
    return inventoryRows;
  }

  // Collect product IDs that have inventory entries
  const productIdsWithInventory = entries.map((e) => e.productId);

  // Fetch products without any inventory entries
  const productsWithoutInventory = await getDb(db).query.product.findMany({
    where:
      productIdsWithInventory.length > 0
        ? and(
            eq(product.organizationId, organizationId),
            notInArray(product.id, productIdsWithInventory),
          )
        : eq(product.organizationId, organizationId),
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
  const productOnlyRows = await Promise.all(
    productsWithoutInventory.map(async (p) => {
      const productFields = buildProductExportFields({
        ...p,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
      return {
        ...productFields,
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
    }),
  );

  return [...inventoryRows, ...productOnlyRows];
};
