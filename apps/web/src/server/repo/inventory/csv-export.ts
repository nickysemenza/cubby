import { type Database } from "~/server/db";
import { type OrganizationId, type LocationId } from "~/schemas/identifiers";
import { getDb } from "~/server/repo/database-helpers";
import { inventoryEntry } from "~/server/db/schema";
import { eq, and } from "drizzle-orm";
import { buildLocationPath } from "~/server/repo/location";
import { amount } from "~/codec/codec";
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
  // Build where conditions
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

  return Promise.all(
    entries.map(async (entry) => {
      const parsedAmount = amount.parse(entry.amount);
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
};
