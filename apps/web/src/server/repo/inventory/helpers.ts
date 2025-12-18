import { type z } from "zod";
import { type Database } from "~/server/db";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";
import { amount } from "~/codec/codec";
import { parseWithContext } from "~/lib/zod-utils";
import {
  getDb,
  extractImagesFromJoinTable,
  addProductSourceMetadata,
} from "~/server/repo/database-helpers";
import {
  unsafeInventoryId,
  unsafeProductId,
  unsafeLocationId,
  type OrganizationId,
  type ProductId,
} from "~/schemas/identifiers";
import { inventoryEntry } from "~/server/db/schema";
import { eq, and } from "drizzle-orm";
import { type InventoryEntryDeepDB } from "./types";

// Re-export price mapping utilities for backward compatibility
export {
  isMoneyUnit,
  extractPriceFromMappings,
  serializeUnitMappings,
} from "~/schemas/price-mapping-utils";

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { Product, location, ...restOfInventoryEntry } = inventoryentry;
  const { type, images: locationImages, ...restOfLocation } = location;

  // Validate amount from JSON column
  const parsedAmount = parseWithContext(amount, restOfInventoryEntry.amount, {
    entityType: "InventoryEntry",
    identifier: { id: restOfInventoryEntry.id },
  });

  return {
    ...restOfInventoryEntry,
    id: unsafeInventoryId(restOfInventoryEntry.id),
    amount: parsedAmount,
    location: {
      ...restOfLocation,
      id: unsafeLocationId(restOfLocation.id),
      type: parseWithContext(locationType, type, {
        entityType: "Location",
        identifier: { id: restOfLocation.id, name: restOfLocation.name },
      }),
      images: extractImagesFromJoinTable(locationImages),
    },
    product: {
      ...(() => {
        const { ingredientId: _ingredientId, ...rest } = Product;
        return rest;
      })(),
      id: unsafeProductId(Product.id),
      unitMappings: addProductSourceMetadata(Product.id, Product.unitMappings),
      images: extractImagesFromJoinTable(Product.images),
    },
  };
};

// Get total quantity of a product across all locations
export const getTotalProductQuantity = async (
  db: Database,
  productId: ProductId,
  organizationId: OrganizationId,
): Promise<number> => {
  const entries = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

  return entries.reduce((total, entry) => {
    const parsedAmount = parseWithContext(amount, entry.amount, {
      entityType: "InventoryEntry",
      identifier: { id: entry.id },
    });
    return total + parsedAmount.value;
  }, 0);
};
