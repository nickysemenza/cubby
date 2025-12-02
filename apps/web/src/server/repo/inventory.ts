import { type Database, type Transaction } from "~/server/db";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";
import { amount, type Amount } from "~/codec/codec";
import {
  withTransaction,
  getDb,
  buildOrderBy,
  insertAndReturnDb,
  insertAndReturn,
  relations,
  updateAndReturnDb,
  updateAndReturn,
  extractImagesFromJoinTable,
  addProductSourceMetadata,
  buildPartialUpdateValues,
} from "~/server/repo/database-helpers";
import { notFoundError } from "~/lib/error-messages";
import {
  InventoryBulkOperationItem,
  type BulkMovePayload,
  type InventoryCSVRow,
  type CSVImportResultItem,
  type ProductChangesPreview,
  type CSVImportResult,
} from "~/schemas/inventory";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import {
  type InventoryId,
  type OrganizationId,
  type ProductId,
  type LocationId,
  type IngredientId,
  unsafeInventoryId,
  unsafeProductId,
  unsafeLocationId,
  unsafeIngredientId,
} from "~/schemas/identifiers";
import {
  inventoryEntry,
  product,
  location,
  productUnitMappings,
  image,
} from "~/server/db/schema";
import { eq, and, count, not, ilike } from "drizzle-orm";
import {
  buildLocationPath,
  findOrCreateLocationByPath,
  findLocationByPath,
} from "~/server/repo/location";
import {
  findProductByNameAndManufacturer,
  quickCreateProduct,
} from "~/server/repo/product";
import { type ProductTopLevelOut } from "~/schemas/product";
import { parseConversionString } from "~/schemas/config-parsers";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { wasm } from "~/hooks/useWasm";

type InventoryEntryDeepDB = typeof inventoryEntry.$inferSelect & {
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

const dbInventoryEntryToAPI: (
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

/**
 * Check if a product with expectedQuantity=1 already exists in a different location.
 * Returns null if no duplicate found, or an object with conflicting location details.
 */
export const checkUniqueProductDuplicate = async (
  db: Database,
  productId: ProductId,
  locationId: LocationId,
): Promise<{ productName: string; locationName: string } | null> => {
  // Check if this is a product with expectedQuantity=1 (unique item)
  const productData = await getDb(db).query.product.findFirst({
    where: eq(product.id, productId),
    columns: { expectedQuantity: true, name: true },
  });

  // If it's a unique item, check for duplicates
  if (productData?.expectedQuantity === 1) {
    const existingEntry = await getDb(db).query.inventoryEntry.findFirst({
      where: and(
        eq(inventoryEntry.productId, productId),
        not(eq(inventoryEntry.locationId, locationId)),
      ),
      with: {
        location: {
          columns: { name: true },
        },
      },
    });

    if (existingEntry) {
      return {
        productName: productData.name,
        locationName: existingEntry.location.name,
      };
    }
  }

  return null;
};

export const getInventoryEntryByID = async (
  db: Database,
  id: InventoryId,
  organizationId: OrganizationId,
) => {
  const res = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.id, id),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    ...relations.inventory.full,
  });

  return res ? dbInventoryEntryToAPI(res) : null;
};

export const inventoryentryList = async (
  db: Database,
  organizationId: OrganizationId,
  sort: SortParams,
  pagination: PaginationParams,
  productNameFilter?: string,
  locationNameFilter?: string,
  locationIdFilter?: string,
) => {
  // Build order by array using helper
  const orderByArray = buildOrderBy(inventoryEntry, sort, [
    "createdAt",
    "amount",
  ]);

  const { take, skip } = buildTakeSkip(pagination);

  // Build where conditions - note Drizzle doesn't support nested filters in relational queries
  // We'll need to do joins for filtering on related tables
  // Always include organization filter for security
  const baseCondition = eq(inventoryEntry.organizationId, organizationId);

  // For location ID filter, we can use a simple where clause
  let whereClause: ReturnType<typeof and> | ReturnType<typeof eq> =
    baseCondition;
  if (locationIdFilter && !productNameFilter && !locationNameFilter) {
    whereClause = and(
      baseCondition,
      eq(inventoryEntry.locationId, locationIdFilter),
    );
  }

  // If we have product or location name filters, we need to use query builder with joins
  if (productNameFilter || locationNameFilter) {
    // Always include organization filter for security
    const conditions = [eq(inventoryEntry.organizationId, organizationId)];

    if (productNameFilter) {
      conditions.push(ilike(product.name, `%${productNameFilter}%`));
    }
    if (locationNameFilter) {
      conditions.push(ilike(location.name, `%${locationNameFilter}%`));
    }
    if (locationIdFilter) {
      conditions.push(eq(inventoryEntry.locationId, locationIdFilter));
    }

    const whereCondition = and(...conditions);

    // Use query builder for complex filtering
    const [results, [countResult]] = await Promise.all([
      getDb(db)
        .select({
          inventoryEntry: inventoryEntry,
          Product: product,
          location: location,
        })
        .from(inventoryEntry)
        .innerJoin(product, eq(inventoryEntry.productId, product.id))
        .innerJoin(location, eq(inventoryEntry.locationId, location.id))
        .where(whereCondition)
        .orderBy(...orderByArray)
        .limit(take)
        .offset(skip),
      getDb(db)
        .select({ count: count() })
        .from(inventoryEntry)
        .innerJoin(product, eq(inventoryEntry.productId, product.id))
        .innerJoin(location, eq(inventoryEntry.locationId, location.id))
        .where(whereCondition),
    ]);

    // Fetch full data with relations for each result
    const fullResults = await Promise.all(
      results.map(async (row) => {
        return await getDb(db).query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, row.inventoryEntry.id),
          ...relations.inventory.full,
        });
      }),
    );

    const inventoryEntries = fullResults
      .filter((r) => r !== undefined)
      .map((r) => dbInventoryEntryToAPI(r));
    return { data: inventoryEntries, count: countResult?.count ?? 0 };
  }

  // Simple case: no complex filters
  const [results, [countResult]] = await Promise.all([
    getDb(db).query.inventoryEntry.findMany({
      where: whereClause,
      ...relations.inventory.full,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
    }),
    getDb(db)
      .select({ count: count() })
      .from(inventoryEntry)
      .where(whereClause),
  ]);

  const inventoryEntries = results.map((r) => dbInventoryEntryToAPI(r));
  return { data: inventoryEntries, count: countResult?.count ?? 0 };
};

interface UpdateInventoryEntryData {
  amount?: z.infer<typeof import("~/codec/codec").amount>;
  productId?: ProductId;
  locationId?: LocationId;
}

export const updateInventoryEntry = async (
  db: Database,
  id: InventoryId,
  organizationId: OrganizationId,
  data: UpdateInventoryEntryData,
) => {
  // Build update values using helper to filter undefined
  const updateValues = buildPartialUpdateValues({
    amount: data.amount,
    productId: data.productId,
    locationId: data.locationId,
  });

  const updated = await updateAndReturnDb(
    db,
    inventoryEntry,
    updateValues,
    and(
      eq(inventoryEntry.id, id),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  );

  // Fetch with relations
  const result = await getDb(db).query.inventoryEntry.findFirst({
    where: eq(inventoryEntry.id, updated.id),
    ...relations.inventory.full,
  });

  if (!result) {
    throw new Error(notFoundError("Inventory entry", id) + " after update");
  }

  return dbInventoryEntryToAPI(result);
};

interface CreateInventoryEntryData {
  amount: z.infer<typeof import("~/codec/codec").amount>;
  productId: ProductId;
  locationId: LocationId;
}

export const createInventoryEntry = async (
  db: Database,
  data: CreateInventoryEntryData,
  organizationId: OrganizationId,
) => {
  const created = await insertAndReturnDb(db, inventoryEntry, {
    organizationId: organizationId,
    productId: data.productId,
    locationId: data.locationId,
    amount: data.amount,
  });

  // Fetch with relations
  const result = await getDb(db).query.inventoryEntry.findFirst({
    where: eq(inventoryEntry.id, created.id),
    ...relations.inventory.full,
  });

  if (!result) {
    throw new Error("Failed to fetch created inventory entry");
  }

  return dbInventoryEntryToAPI(result);
};

export const bulkProcessInventoryEntries = async (
  db: Database,
  locationId: LocationId,
  items: InventoryBulkOperationItem[],
  organizationId: OrganizationId,
) => {
  // Use a transaction to ensure all operations are processed atomically
  const processedItems = await withTransaction(db, async (tx: Transaction) => {
    const results: InventoryEntryDeepDB[] = [];

    // First, get all existing inventory entries for this location
    const existingItems = await tx.query.inventoryEntry.findMany({
      where: eq(inventoryEntry.locationId, locationId),
      ...relations.inventory.full,
    });

    // Get IDs of items in the submitted array
    const submittedIds = items.filter((item) => item.id).map((item) => item.id);

    // Find items to delete (existing items not in the submitted array)
    const itemsToDelete = existingItems.filter(
      (item) => !submittedIds.includes(item.id),
    );

    // Delete items that are not in the submitted array
    for (const item of itemsToDelete) {
      await tx.delete(inventoryEntry).where(eq(inventoryEntry.id, item.id));
    }

    // Process submitted items - create new or update existing
    for (const item of items) {
      if (!item.id) {
        // Create new inventory entry - productId and amount are required
        if (!item.productId || !item.amount) {
          throw new Error("productId and amount are required for new items");
        }
        const created = await insertAndReturn(tx, inventoryEntry, {
          organizationId: organizationId,
          productId: item.productId,
          locationId: locationId,
          amount: item.amount,
        });

        // Fetch with relations
        const fullCreated = await tx.query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, created.id),
          ...relations.inventory.full,
        });

        if (fullCreated) {
          results.push(fullCreated);
        }
      } else {
        // Update existing inventory entry using helper to filter undefined
        const updateValues = buildPartialUpdateValues({
          amount: item.amount,
          productId: item.productId,
        });

        // Only process if there are actual updates
        if (Object.keys(updateValues).length > 0) {
          const updated = await updateAndReturn(
            tx,
            inventoryEntry,
            updateValues,
            eq(inventoryEntry.id, item.id),
          );

          // Fetch with relations
          const fullUpdated = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, updated.id),
            ...relations.inventory.full,
          });

          if (fullUpdated) {
            results.push(fullUpdated);
          }
        } else {
          // If no updates, just fetch the current item
          const current = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, item.id),
            ...relations.inventory.full,
          });

          if (current) {
            results.push(current);
          }
        }
      }
    }

    // Update the location's lastBulkInventory timestamp
    await tx
      .update(location)
      .set({ lastBulkInventory: new Date() })
      .where(eq(location.id, locationId));

    return results;
  });

  return processedItems.map(dbInventoryEntryToAPI);
};

/**
 * Find inventory entry by product and location
 */
export const findInventoryByProductAndLocation = async (
  db: Database | Transaction,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
) => {
  const dbClient = "query" in db ? db : getDb(db as Database);
  return await dbClient.query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    ...relations.inventory.full,
  });
};

/**
 * Bulk move inventory entries from one location to another.
 * Supports partial moves (moving less than the full quantity).
 */
export const bulkMoveInventoryEntries = async (
  db: Database,
  organizationId: OrganizationId,
  payload: BulkMovePayload,
) => {
  // Validate source and target are different
  if (payload.sourceLocationId === payload.targetLocationId) {
    throw new Error("Source and target locations must be different");
  }

  const processedItems = await withTransaction(db, async (tx: Transaction) => {
    const results: InventoryEntryDeepDB[] = [];

    for (const item of payload.items) {
      // 1. Get source entry
      const sourceEntry = await tx.query.inventoryEntry.findFirst({
        where: and(
          eq(inventoryEntry.id, item.inventoryEntryId),
          eq(inventoryEntry.organizationId, organizationId),
        ),
        ...relations.inventory.full,
      });

      if (!sourceEntry) {
        throw new Error(
          notFoundError("Inventory entry", item.inventoryEntryId),
        );
      }

      // 2. Parse quantities (amount.value is already a number)
      const parsedSourceAmount = amount.parse(sourceEntry.amount);
      const sourceQuantity = parsedSourceAmount.value;
      const moveQuantity = item.quantity.value;

      if (moveQuantity > sourceQuantity) {
        throw new Error(
          `Cannot move ${moveQuantity} ${item.quantity.unit} - only ${sourceQuantity} available`,
        );
      }

      // 3. Check if product already exists at target location
      const existingAtTarget = await tx.query.inventoryEntry.findFirst({
        where: and(
          eq(inventoryEntry.productId, sourceEntry.productId),
          eq(inventoryEntry.locationId, payload.targetLocationId),
          eq(inventoryEntry.organizationId, organizationId),
        ),
        ...relations.inventory.full,
      });

      if (moveQuantity >= sourceQuantity) {
        // Full move
        if (existingAtTarget) {
          // Merge with existing entry at target
          const existingAmount = amount.parse(existingAtTarget.amount);
          const existingQuantity = existingAmount.value;
          const newQuantity = existingQuantity + moveQuantity;

          // Update target entry with combined quantity
          await updateAndReturn(
            tx,
            inventoryEntry,
            { amount: { value: newQuantity, unit: item.quantity.unit } },
            eq(inventoryEntry.id, existingAtTarget.id),
          );

          // Delete source entry since we moved everything
          await tx
            .delete(inventoryEntry)
            .where(eq(inventoryEntry.id, item.inventoryEntryId));

          // Fetch updated target entry
          const updatedTarget = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, existingAtTarget.id),
            ...relations.inventory.full,
          });
          if (updatedTarget) results.push(updatedTarget);
        } else {
          // Just update location of existing entry
          await updateAndReturn(
            tx,
            inventoryEntry,
            { locationId: payload.targetLocationId },
            eq(inventoryEntry.id, item.inventoryEntryId),
          );

          // Fetch updated entry
          const updated = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, item.inventoryEntryId),
            ...relations.inventory.full,
          });
          if (updated) results.push(updated);
        }
      } else {
        // Partial move - reduce source and create/update target
        const remainingQuantity = sourceQuantity - moveQuantity;

        // Reduce source quantity
        await updateAndReturn(
          tx,
          inventoryEntry,
          {
            amount: {
              value: remainingQuantity,
              unit: parsedSourceAmount.unit,
            },
          },
          eq(inventoryEntry.id, item.inventoryEntryId),
        );

        if (existingAtTarget) {
          // Add to existing entry at target
          const existingAmount = amount.parse(existingAtTarget.amount);
          const existingQuantity = existingAmount.value;
          const newQuantity = existingQuantity + moveQuantity;

          await updateAndReturn(
            tx,
            inventoryEntry,
            { amount: { value: newQuantity, unit: item.quantity.unit } },
            eq(inventoryEntry.id, existingAtTarget.id),
          );

          // Fetch updated target entry
          const updatedTarget = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, existingAtTarget.id),
            ...relations.inventory.full,
          });
          if (updatedTarget) results.push(updatedTarget);
        } else {
          // Create new entry at target
          const created = await insertAndReturn(tx, inventoryEntry, {
            organizationId: organizationId,
            productId: sourceEntry.productId,
            locationId: payload.targetLocationId,
            amount: item.quantity,
          });

          // Fetch with relations
          const fullCreated = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, created.id),
            ...relations.inventory.full,
          });
          if (fullCreated) results.push(fullCreated);
        }
      }
    }

    return results;
  });

  return processedItems.map(dbInventoryEntryToAPI);
};

// Export inventory to CSV format
export interface InventoryCSVExportRow {
  product_name: string;
  manufacturer: string;
  upc: string;
  location_path: string;
  quantity: number;
  unit: string;
  expected_qty: number | null;
  price: number | null;
  unit_mappings: string | null;
  ingredient_name: string | null;
}

// Helper to check if a unit is a money/currency unit
const isMoneyUnit = (w: wasm, unit: string): boolean => {
  try {
    return w.measure_kind({ value: 1, unit }) === "money";
  } catch {
    return false;
  }
};

// Helper to extract price from unit mappings (finds "1 each → $X" mapping)
const extractPriceFromMappings = (
  w: wasm,
  mappings: Array<{ a: Amount; b: Amount }>,
): number | null => {
  const priceMapping = mappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && isMoneyUnit(w, m.b.unit),
  );
  return priceMapping ? priceMapping.b.value : null;
};

// Helper to serialize unit mappings to string (excluding price/money mappings)
const serializeUnitMappings = (
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

export const exportInventoryToCSV = async (
  w: wasm,
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

  return entries.map((entry) => {
    const parsedAmount = amount.parse(entry.amount);
    return {
      product_name: entry.Product.name,
      manufacturer: entry.Product.manufacturer,
      upc: entry.Product.upc ?? "",
      location_path: buildLocationPath(entry.location),
      quantity: parsedAmount.value,
      unit: parsedAmount.unit,
      expected_qty: entry.Product.expectedQuantity,
      price: extractPriceFromMappings(w, entry.Product.unitMappings),
      unit_mappings: serializeUnitMappings(w, entry.Product.unitMappings),
      ingredient_name: entry.Product.Ingredient?.name ?? null,
    };
  });
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

// Helper: Parse semicolon-separated aliases string
const parseAliasesString = (
  aliasesStr: string | null | undefined,
): string[] => {
  if (!aliasesStr) return [];
  return aliasesStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
};

// Helper: Find or create product for CSV import
const findOrCreateProductForImport = async (
  db: Database,
  organizationId: OrganizationId,
  productName: string,
  manufacturer: string,
  upc: string | undefined,
  expectedQty: number | null | undefined,
  ingredientName: string | null | undefined,
  ingredientFlag: boolean | undefined,
  model: string | undefined,
  ndbNumber: number | undefined,
  aliasesStr: string | null | undefined,
): Promise<ProductTopLevelOut> => {
  // Parse aliases from semicolon-separated string
  const aliases = parseAliasesString(aliasesStr);

  // Determine ingredient name: explicit name takes precedence, then ingredient flag uses product name
  const effectiveIngredientName =
    ingredientName ?? (ingredientFlag ? productName : null);

  // If ingredient should be linked, find or create it with aliases
  let ingredientId: IngredientId | null = null;
  if (effectiveIngredientName) {
    const ingredientData = await findOrCreateIngredient(
      db,
      effectiveIngredientName,
      aliases.length > 0 ? aliases : undefined,
      organizationId,
    );
    ingredientId = unsafeIngredientId(ingredientData.id);
  }

  let productData = await findProductByNameAndManufacturer(
    db,
    productName,
    manufacturer,
    organizationId,
  );

  if (!productData) {
    // Create new product with all fields from CSV
    productData = await quickCreateProduct(
      db,
      {
        name: productName,
        manufacturer,
        upc: upc ?? null,
        expectedQuantity: expectedQty ?? 1,
        model: model ?? null,
        ndb_number: ndbNumber ?? null,
        ingredientId,
      },
      organizationId,
    );
  } else {
    // Update existing product if CSV provides values
    const updates: {
      expectedQuantity?: number;
      ingredientId?: IngredientId | null;
      model?: string | null;
      ndb_number?: number | null;
    } = {};
    if (expectedQty != null) {
      updates.expectedQuantity = expectedQty;
    }
    if (model != null) {
      updates.model = model;
    }
    if (ndbNumber != null) {
      updates.ndb_number = ndbNumber;
    }
    if (ingredientId != null) {
      // Check if product already has an ingredient linked (need to query DB)
      const existingProduct = await getDb(db).query.product.findFirst({
        where: eq(product.id, productData.id),
        columns: { ingredientId: true },
      });
      if (existingProduct?.ingredientId == null) {
        updates.ingredientId = ingredientId;
      }
    }

    if (Object.keys(updates).length > 0) {
      await getDb(db)
        .update(product)
        .set(updates)
        .where(eq(product.id, productData.id));
      // Update local copy for fields that might have changed
      if (updates.expectedQuantity != null) {
        productData = {
          ...productData,
          expectedQuantity: updates.expectedQuantity,
        };
      }
      if (updates.model != null) {
        productData = {
          ...productData,
          model: updates.model,
        };
      }
      if (updates.ndb_number != null) {
        productData = {
          ...productData,
          ndb_number: updates.ndb_number,
        };
      }
    }
  }

  return productData;
};

// Helper: Create or update price unit mapping for a product
export const createOrUpdatePriceMapping = async (
  db: Database,
  productId: ProductId,
  price: number,
  source: string = "csv-import",
): Promise<void> => {
  // Check if a price mapping already exists (1 each → $X)
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = existingMappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && m.b.unit === "dollar",
  );

  if (existingPriceMapping) {
    // Update existing price mapping
    await getDb(db)
      .update(productUnitMappings)
      .set({ b: { value: price, unit: "dollar" }, source })
      .where(eq(productUnitMappings.id, existingPriceMapping.id));
  } else {
    // Create new price mapping
    await getDb(db)
      .insert(productUnitMappings)
      .values({
        productId,
        a: { value: 1, unit: "each" },
        b: { value: price, unit: "dollar" },
        source,
      });
  }
};

// Helper: Create unit mappings from a semicolon-separated string
const createUnitMappingsFromString = async (
  db: Database,
  productId: ProductId,
  mappingsStr: string,
): Promise<void> => {
  // Parse "4 lb = $5; 1 cup = 120g" format
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of mappingParts) {
    try {
      const { from, to, source } = parseConversionString(part);
      await getDb(db)
        .insert(productUnitMappings)
        .values({
          productId,
          a: from,
          b: to,
          source: source ?? "csv-import",
        });
    } catch (e) {
      // Log warning but continue with other mappings
      console.warn(`Failed to parse unit mapping: ${part}`, e);
    }
  }
};

// Helper: Move inventory entries to new location
const moveInventoryEntries = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
): Promise<string[]> => {
  const existingEntries = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    with: {
      location: true,
    },
  });

  if (existingEntries.length === 0) {
    return [];
  }

  // Delete existing entries
  for (const entry of existingEntries) {
    await getDb(db)
      .delete(inventoryEntry)
      .where(eq(inventoryEntry.id, entry.id));
  }

  // Check if already exists at target location
  const existingAtTarget = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

  if (!existingAtTarget) {
    await getDb(db).insert(inventoryEntry).values({
      organizationId,
      productId,
      locationId: targetLocationId,
      amount: newAmount,
    });
  }

  return existingEntries.map((e) => e.location.name);
};

// Helper: Create or update inventory at target location
const createOrUpdateInventoryAtLocation = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
): Promise<"created" | "updated"> => {
  const existingAtTarget = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

  if (existingAtTarget) {
    const existingAmount = amount.parse(existingAtTarget.amount);
    await getDb(db)
      .update(inventoryEntry)
      .set({
        amount: {
          value: existingAmount.value + newAmount.value,
          unit: newAmount.unit,
        },
      })
      .where(eq(inventoryEntry.id, existingAtTarget.id));
    return "updated";
  }

  await getDb(db).insert(inventoryEntry).values({
    organizationId,
    productId,
    locationId: targetLocationId,
    amount: newAmount,
  });
  return "created";
};

// Helper: Check what price mapping changes would occur (for preview)
const checkPriceMappingChanges = async (
  db: Database,
  productId: ProductId,
  newPrice: number,
): Promise<number | undefined> => {
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = existingMappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && m.b.unit === "dollar",
  );

  // Return the new price if it would be set or changed
  if (!existingPriceMapping || existingPriceMapping.b.value !== newPrice) {
    return newPrice;
  }
  return undefined;
};

// Helper: Parse unit mappings string and return count + details (for preview)
const parseUnitMappingsForPreview = (
  mappingsStr: string,
): { count: number; details: Array<{ from: string; to: string }> } => {
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const details = mappingParts.map((part) => {
    // Parse "1 stick = 113.4g" format
    const [from, to] = part.split("=").map((s) => s.trim());
    return { from: from ?? part, to: to ?? "" };
  });

  return { count: mappingParts.length, details };
};

// Helper: Preview what would happen for a product (without creating)
const previewProductForImport = async (
  db: Database,
  organizationId: OrganizationId,
  productName: string,
  manufacturer: string,
  expectedQty: number | null | undefined,
  ingredientName: string | null | undefined,
  ingredientFlag: boolean | undefined,
  model: string | undefined,
  ndbNumber: number | undefined,
  aliasesStr: string | null | undefined,
): Promise<{
  existingProduct: ProductTopLevelOut | null;
  productWillBeCreated: boolean;
  productChanges: ProductChangesPreview;
}> => {
  const productChanges: ProductChangesPreview = {};
  const aliases = parseAliasesString(aliasesStr);
  const effectiveIngredientName =
    ingredientName ?? (ingredientFlag ? productName : null);

  const existingProduct = await findProductByNameAndManufacturer(
    db,
    productName,
    manufacturer,
    organizationId,
  );

  if (!existingProduct) {
    // Product will be created
    if (expectedQty != null) {
      productChanges.expectedQuantityWillBeSet = expectedQty;
    }
    if (effectiveIngredientName) {
      productChanges.ingredientWillBeLinked = effectiveIngredientName;
    }
    if (model) {
      productChanges.modelWillBeSet = model;
    }
    if (ndbNumber != null) {
      productChanges.ndbNumberWillBeSet = ndbNumber;
    }
    if (aliases.length > 0) {
      productChanges.aliasesWillBeAdded = aliases;
    }
    return {
      existingProduct: null,
      productWillBeCreated: true,
      productChanges,
    };
  }

  // Product exists - check what would be updated
  if (expectedQty != null && existingProduct.expectedQuantity !== expectedQty) {
    productChanges.expectedQuantityWillBeSet = expectedQty;
  }

  if (model && existingProduct.model !== model) {
    productChanges.modelWillBeSet = model;
  }

  if (ndbNumber != null && existingProduct.ndb_number !== ndbNumber) {
    productChanges.ndbNumberWillBeSet = ndbNumber;
  }

  // Check ingredient linking
  if (effectiveIngredientName) {
    const productWithIngredient = await getDb(db).query.product.findFirst({
      where: eq(product.id, existingProduct.id),
      columns: { ingredientId: true },
    });
    if (productWithIngredient?.ingredientId == null) {
      productChanges.ingredientWillBeLinked = effectiveIngredientName;
    }
  }

  // Aliases will be added to ingredient if it's being linked
  if (aliases.length > 0 && effectiveIngredientName) {
    productChanges.aliasesWillBeAdded = aliases;
  }

  return {
    existingProduct,
    productWillBeCreated: false,
    productChanges,
  };
};

// Helper: Get locations where a product currently exists (for move preview)
const getExistingInventoryLocations = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
): Promise<string[]> => {
  const existingEntries = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    with: {
      location: true,
    },
  });

  return existingEntries.map((e) => e.location.name);
};

// Helper: Check if inventory already exists at target location and if quantity matches
const checkInventoryMatch = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  expectedAmount: { value: number; unit: string },
): Promise<{ exists: boolean; matches: boolean }> => {
  const existing = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });
  if (!existing) return { exists: false, matches: false };
  const existingAmount = amount.parse(existing.amount);
  const matches =
    existingAmount.value === expectedAmount.value &&
    existingAmount.unit === expectedAmount.unit;
  return { exists: true, matches };
};

// Import CSV data with smart move logic
// When dryRun=true, performs all lookups but no writes, returning what would happen
export const importInventoryFromCSV = async (
  db: Database,
  organizationId: OrganizationId,
  rows: InventoryCSVRow[],
  dryRun: boolean = false,
): Promise<CSVImportResult> => {
  const results: CSVImportResultItem[] = [];
  let created = 0;
  let moved = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let productOnly = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const manufacturer = row.manufacturer ?? UNSPECIFIED_MANUFACTURER;

      // Check if this is a product-only row (no location_path)
      const isProductOnly =
        !row.location_path || row.location_path.trim() === "";

      let productData: ProductTopLevelOut | null = null;
      let productWillBeCreated = false;
      let productChanges: ProductChangesPreview = {};

      if (dryRun) {
        // Preview mode: just check what would happen
        const preview = await previewProductForImport(
          db,
          organizationId,
          row.product_name,
          manufacturer,
          row.expected_qty,
          row.ingredient_name,
          row.ingredient,
          row.model,
          row.ndb_number,
          row.aliases,
        );
        productData = preview.existingProduct;
        productWillBeCreated = preview.productWillBeCreated;
        productChanges = preview.productChanges;

        // Check price changes if product exists and price provided
        if (row.price != null && productData) {
          const priceChange = await checkPriceMappingChanges(
            db,
            productData.id,
            row.price,
          );
          if (priceChange !== undefined) {
            productChanges.priceWillBeSet = priceChange;
          }
        } else if (row.price != null && productWillBeCreated) {
          // New product will get this price
          productChanges.priceWillBeSet = row.price;
        }

        // Parse unit mappings for preview (count and details)
        if (row.unit_mappings) {
          const mappings = parseUnitMappingsForPreview(row.unit_mappings);
          productChanges.unitMappingsWillBeAdded = mappings.count;
          productChanges.unitMappingsDetail = mappings.details;
        }
      } else {
        // Normal mode: actually create/update product
        productData = await findOrCreateProductForImport(
          db,
          organizationId,
          row.product_name,
          manufacturer,
          row.upc,
          row.expected_qty,
          row.ingredient_name,
          row.ingredient,
          row.model,
          row.ndb_number,
          row.aliases,
        );

        // Handle price mapping if provided
        if (row.price != null) {
          await createOrUpdatePriceMapping(db, productData.id, row.price);
        }

        // Handle unit mappings if provided
        if (row.unit_mappings) {
          await createUnitMappingsFromString(
            db,
            productData.id,
            row.unit_mappings,
          );
        }
      }

      // Handle product-only rows (no inventory placement)
      if (isProductOnly) {
        results.push({
          rowIndex: i,
          action: "product_only",
          productName: row.product_name,
          locationPath: undefined,
          message: productWillBeCreated
            ? "Product will be created"
            : "Product already exists",
          productWillBeCreated,
          productChanges:
            Object.keys(productChanges).length > 0 ? productChanges : undefined,
        });
        productOnly++;
        continue;
      }

      // For rows with location_path, continue with inventory processing
      let targetLocationId: LocationId | null = null;
      let locationWillBeCreated = false;

      if (dryRun) {
        // Try to find location without creating
        targetLocationId = await findLocationByPath(
          db,
          organizationId,
          row.location_path!,
        );
        if (!targetLocationId) {
          locationWillBeCreated = true;
        }
      } else {
        targetLocationId = await findOrCreateLocationByPath(
          db,
          organizationId,
          row.location_path!,
        );
      }

      // For dryRun with no existing product, we know it will be "created"
      if (dryRun && productWillBeCreated) {
        results.push({
          rowIndex: i,
          action: "created",
          productName: row.product_name,
          locationPath: row.location_path,
          productWillBeCreated: true,
          locationWillBeCreated,
          productChanges:
            Object.keys(productChanges).length > 0 ? productChanges : undefined,
        });
        created++;
        continue;
      }

      // For dryRun with no location found, check if this could be a MOVE before defaulting to "created"
      if (dryRun && !targetLocationId) {
        // Check move conditions: product has expectedQuantity and exists elsewhere
        if (productData && productData.expectedQuantity !== null) {
          const totalExistingQty = await getTotalProductQuantity(
            db,
            productData.id,
            organizationId,
          );

          if (totalExistingQty >= productData.expectedQuantity) {
            // This is a move to a new location
            const existingLocations = await getExistingInventoryLocations(
              db,
              organizationId,
              productData.id,
            );

            if (existingLocations.length > 0) {
              results.push({
                rowIndex: i,
                action: "moved",
                productName: row.product_name,
                locationPath: row.location_path,
                movedFrom: existingLocations,
                message: `Will move from ${existingLocations.join(", ")}`,
                productWillBeCreated,
                locationWillBeCreated: true,
                productChanges:
                  Object.keys(productChanges).length > 0
                    ? productChanges
                    : undefined,
              });
              moved++;
              continue;
            }
          }
        }

        // Not a move - it's a create with new location
        results.push({
          rowIndex: i,
          action: "created",
          productName: row.product_name,
          locationPath: row.location_path,
          productWillBeCreated,
          locationWillBeCreated: true,
          productChanges:
            Object.keys(productChanges).length > 0 ? productChanges : undefined,
        });
        created++;
        continue;
      }

      // At this point we have productData and targetLocationId
      if (!productData || !targetLocationId) {
        throw new Error("Unexpected state: missing product or location data");
      }

      const newAmount = { value: row.quantity, unit: row.unit };

      // Check if inventory exists at target and if it matches
      const inventoryCheck = await checkInventoryMatch(
        db,
        organizationId,
        productData.id,
        targetLocationId,
        newAmount,
      );

      // Get total existing quantity for move logic
      const totalExistingQty = await getTotalProductQuantity(
        db,
        productData.id,
        organizationId,
      );

      // Smart move logic: if at expected capacity and NOT already at target, move instead of adding
      const shouldMove =
        productData.expectedQuantity !== null &&
        totalExistingQty >= productData.expectedQuantity;

      // Check if product is ONLY at the target location (don't move if already there)
      const existingLocations = shouldMove
        ? await getExistingInventoryLocations(
            db,
            organizationId,
            productData.id,
          )
        : [];
      const isOnlyAtTarget =
        existingLocations.length === 1 && inventoryCheck.exists;

      if (shouldMove && !isOnlyAtTarget && existingLocations.length > 0) {
        if (dryRun) {
          // Preview: show where it would move from
          results.push({
            rowIndex: i,
            action: "moved",
            productName: row.product_name,
            locationPath: row.location_path,
            movedFrom: existingLocations,
            message: `Will move from ${existingLocations.join(", ")}`,
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          moved++;
          continue;
        } else {
          // Actually perform the move
          const fromLocations = await moveInventoryEntries(
            db,
            organizationId,
            productData.id,
            targetLocationId,
            newAmount,
          );

          if (fromLocations.length > 0) {
            results.push({
              rowIndex: i,
              action: "moved",
              productName: row.product_name,
              locationPath: row.location_path,
              movedFrom: fromLocations,
              message: `Moved from ${fromLocations.join(", ")}`,
            });
            moved++;
            continue;
          }
        }
      }

      // Check for skip (exact match) or update (exists but different quantity)
      if (dryRun) {
        if (inventoryCheck.matches) {
          // Exact match - skip (but may still have product changes)
          results.push({
            rowIndex: i,
            action: "skipped",
            productName: row.product_name,
            locationPath: row.location_path,
            message: "Already exists with same quantity",
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          skipped++;
        } else if (inventoryCheck.exists) {
          // Exists but quantity differs - would be updated
          results.push({
            rowIndex: i,
            action: "updated",
            productName: row.product_name,
            locationPath: row.location_path,
            message: "Will update quantity",
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          updated++;
        } else {
          // Doesn't exist - would be created
          results.push({
            rowIndex: i,
            action: "created",
            productName: row.product_name,
            locationPath: row.location_path,
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          created++;
        }
      } else {
        // Actually create or update inventory
        if (inventoryCheck.matches) {
          // Exact match - skip
          results.push({
            rowIndex: i,
            action: "skipped",
            productName: row.product_name,
            locationPath: row.location_path,
            message: "Already exists with same quantity",
          });
          skipped++;
        } else {
          const action = await createOrUpdateInventoryAtLocation(
            db,
            organizationId,
            productData.id,
            targetLocationId,
            newAmount,
          );

          if (action === "updated") {
            results.push({
              rowIndex: i,
              action: "updated",
              productName: row.product_name,
              locationPath: row.location_path,
              message: "Updated existing entry quantity",
            });
            updated++;
          } else {
            results.push({
              rowIndex: i,
              action: "created",
              productName: row.product_name,
              locationPath: row.location_path,
            });
            created++;
          }
        }
      }
    } catch (error) {
      results.push({
        rowIndex: i,
        action: "error",
        productName: row.product_name,
        locationPath: row.location_path,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      errors++;
    }
  }

  return {
    created,
    moved,
    updated,
    skipped,
    errors,
    productOnly,
    items: results,
  };
};
