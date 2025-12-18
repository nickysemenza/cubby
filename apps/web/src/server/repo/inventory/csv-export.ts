import { type Database } from "~/server/db";
import {
  type OrganizationId,
  type LocationId,
  locationId as locationIdSchema,
} from "~/schemas/identifiers";
import { getDb } from "~/server/repo/database-helpers";
import { inventoryEntry, product } from "~/server/db/schema";
import { eq, and, notInArray } from "drizzle-orm";
import { buildLocationPath } from "~/server/repo/location";
import { amount } from "~/codec/codec";
import { parseWithContext } from "~/lib/zod-utils";
import {
  extractPriceFromMappings,
  serializeUnitMappings,
} from "~/schemas/price-mapping-utils";
import { type InventoryCSVExportRow } from "./types";

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
        },
      },
      location: {
        with: {
          parent: {
            with: {
              parent: {
                with: {
                  parent: true, // Support up to 4 levels deep
                },
              },
            },
          },
        },
      },
    },
  });

  // Convert inventory entries to export rows
  const inventoryRows = await Promise.all(
    entries.map(async (entry) => {
      const parsedAmount = parseWithContext(amount, entry.amount, {
        entityType: "InventoryEntry",
        identifier: { id: entry.id },
      });
      const priceAmount = await extractPriceFromMappings(
        entry.Product.unitMappings,
      );
      return {
        product_name: entry.Product.name,
        manufacturer: entry.Product.manufacturer,
        upc: entry.Product.upc ?? "",
        model: entry.Product.model ?? null,
        ndb_number: entry.Product.ndb_number ?? null,
        location_path: buildLocationPath(entry.location),
        location_id: locationIdSchema.parse(entry.locationId),
        quantity: parsedAmount.value,
        unit: parsedAmount.unit,
        expected_qty: entry.Product.expectedQuantity,
        price: priceAmount?.value ?? null,
        unit_mappings: await serializeUnitMappings(entry.Product.unitMappings),
        ingredient_name: entry.Product.Ingredient?.name ?? null,
        aliases: entry.Product.Ingredient?.aliases?.join("; ") ?? null,
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
    },
  });

  // Convert products without inventory to export rows (product-only rows)
  const productOnlyRows = await Promise.all(
    productsWithoutInventory.map(async (p) => {
      const priceAmount = await extractPriceFromMappings(p.unitMappings);
      return {
        product_name: p.name,
        manufacturer: p.manufacturer,
        upc: p.upc ?? "",
        model: p.model ?? null,
        ndb_number: p.ndb_number ?? null,
        location_path: "", // Empty for product-only rows
        location_id: null, // No location for product-only rows
        quantity: null, // No inventory
        unit: null, // No inventory
        expected_qty: p.expectedQuantity,
        price: priceAmount?.value ?? null,
        unit_mappings: await serializeUnitMappings(p.unitMappings),
        ingredient_name: p.Ingredient?.name ?? null,
        aliases: p.Ingredient?.aliases?.join("; ") ?? null,
      };
    }),
  );

  return [...inventoryRows, ...productOnlyRows];
};
