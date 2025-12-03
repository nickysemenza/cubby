import { type z } from "zod";
import { type Database } from "~/server/db";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";
import { amount, type Amount } from "~/codec/codec";
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
import { type wasm } from "~/hooks/useWasm";
import { type InventoryEntryDeepDB } from "./types";

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { Product, location, ...restOfInventoryEntry } = inventoryentry;
  const { type, images: locationImages, ...restOfLocation } = location;

  // Validate amount from JSON column
  const parsedAmount = amount.parse(restOfInventoryEntry.amount);

  return {
    ...restOfInventoryEntry,
    id: unsafeInventoryId(restOfInventoryEntry.id),
    amount: parsedAmount,
    location: {
      ...restOfLocation,
      id: unsafeLocationId(restOfLocation.id),
      type: locationType.parse(type),
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
    const parsedAmount = amount.parse(entry.amount);
    return total + parsedAmount.value;
  }, 0);
};

// Helper to check if a unit is a money/currency unit
export const isMoneyUnit = (w: wasm, unit: string): boolean => {
  try {
    return w.measure_kind({ value: 1, unit }) === "money";
  } catch {
    return false;
  }
};

// Helper to extract price from unit mappings (finds "1 each -> $X" mapping)
export const extractPriceFromMappings = (
  w: wasm,
  mappings: Array<{ a: Amount; b: Amount }>,
): number | null => {
  const priceMapping = mappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && isMoneyUnit(w, m.b.unit),
  );
  return priceMapping ? priceMapping.b.value : null;
};

// Helper to serialize unit mappings to string (excluding price/money mappings)
export const serializeUnitMappings = (
  w: wasm,
  mappings: Array<{ a: Amount; b: Amount; source: string | null }>,
): string | null => {
  // Filter out price mappings (where either a or b is a money unit)
  const nonPriceMappings = mappings.filter(
    (m) => !isMoneyUnit(w, m.a.unit) && !isMoneyUnit(w, m.b.unit),
  );
  if (nonPriceMappings.length === 0) return null;
  return nonPriceMappings
    .map((m) => {
      const sourceStr = m.source ? ` @ ${m.source}` : "";
      return `${m.a.value} ${m.a.unit} = ${m.b.value} ${m.b.unit}${sourceStr}`;
    })
    .join("; ");
};
