import { type FoodLookupParam, foodLookupParam } from "@recipehub/usda-schemas";
import { and, count, eq, ilike, inArray, isNotNull, isNull } from "drizzle-orm";
import type { z } from "zod";
import { getSortableFields } from "~/entities/entities";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { generateProductShortcode } from "~/lib/shortcode";
import { parseWithContext } from "~/lib/zod-utils";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import type { ActorContext } from "~/schemas/context";
import {
  type ProductId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "~/schemas/identifiers";
import { locationType } from "~/schemas/location";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/pagination";
import { computeProductPrice } from "~/schemas/price-mapping-utils";
import {
  hasFoodIndicators,
  type ProductCategory,
  type ProductCreateInput,
  type ProductTopLevelOut,
  productTopLevelOut,
} from "~/schemas/product";
import { createAppError } from "~/server/api/trpc";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  image,
  type ingredient,
  type inventoryEntry,
  type location,
  product,
  productImage,
  productUnitMappings,
} from "~/server/db/schema";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  addProductSourceMetadata,
  associatePendingImages,
  buildOrderBy,
  executeListQueryWithCount,
  extractImagesFromJoinTable,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  insertAndReturnDb,
  mapRelation,
  relations,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";

/**
 * Generate a unique product shortcode with collision retry.
 * Retries up to 10 times if collision detected.
 */
const generateUniqueProductShortcode = async (
  db: Database,
): Promise<string> => {
  const MAX_RETRIES = 10;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generateProductShortcode();
    const existing = await getDb(db).query.product.findFirst({
      where: eq(product.shortcode, code),
      columns: { id: true },
    });
    if (!existing) {
      return code;
    }
  }
  throw new Error(
    "Failed to generate unique product shortcode after max retries",
  );
};

// Type for deeply nested product query
type ProductDeepDB = typeof product.$inferSelect & {
  Ingredient: typeof ingredient.$inferSelect | null;
  unitMappings: Array<typeof productUnitMappings.$inferSelect>;
  InventoryEntry: Array<
    typeof inventoryEntry.$inferSelect & {
      location: typeof location.$inferSelect & {
        images: Array<{
          image: typeof image.$inferSelect;
        }>;
      };
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
  }>;
};

// Convert product to food lookup parameter
// Only returns a lookup param if UPC/NDB values pass schema validation
export const foodLookupParamFromProduct = (product: {
  upc: string | null;
  ndb_number: number | null;
}): FoodLookupParam | null => {
  // Try UPC lookup first
  if (product.upc !== null) {
    const result = foodLookupParam.safeParse({
      kind: "upc",
      gtin_upc: product.upc,
    });
    if (result.success) return result.data;
  }
  // Fall back to NDB lookup
  if (product.ndb_number !== null) {
    const result = foodLookupParam.safeParse({
      kind: "ndb",
      ndb_number: product.ndb_number,
    });
    if (result.success) return result.data;
  }
  return null;
};

// Function to find products by UPC or NDB number - used for food items in usda.ts
export const findProductsByFoodIdentifier = async (
  db: Database,
  rawLookup?: FoodLookupParam,
) => {
  if (!rawLookup) {
    return [];
  }

  // validate that lookup zod schema is good
  const lookup = foodLookupParam.parse(rawLookup);

  // Find all matching products
  const res = await getDb(db).query.product.findMany({
    where:
      lookup.kind === "upc"
        ? eq(product.upc, lookup.gtin_upc)
        : eq(product.ndb_number, lookup.ndb_number),
    ...relations.product.full,
  });

  return res.map((p) => ({
    ...p,
    shortcode: unsafeProductShortcode(p.shortcode),
    images: extractImagesFromJoinTable(p.images),
  }));
};

const dbProductToAPI = (
  productData: ProductDeepDB,
): z.infer<typeof productWithIngredientAndInventoryAndMappingsOut> => {
  const {
    Ingredient,
    unitMappings,
    InventoryEntry,
    images,
    shortcode,
    ...restOfProduct
  } = productData;

  const result = {
    ...restOfProduct,
    shortcode: shortcode ? unsafeProductShortcode(shortcode) : null,
    ingredient: Ingredient,
    unitMappings: addProductSourceMetadata(productData.id, unitMappings),
    images: extractImagesFromJoinTable(images),
    inventoryEntry: mapRelation(InventoryEntry, (entry) => {
      const {
        type,
        images: locationImages,
        ...restOfLocation
      } = entry.location;

      return {
        ...entry,
        amount: entry.amount as { value: number; unit: string },
        location: {
          ...restOfLocation,
          id: unsafeLocationId(restOfLocation.id),
          shortcode: restOfLocation.shortcode
            ? unsafeLocationShortcode(restOfLocation.shortcode)
            : null,
          type: locationType.parse(type),
          images: extractImagesFromJoinTable(locationImages),
        },
      };
    }),
  };

  return parseWithContext(
    productWithIngredientAndInventoryAndMappingsOut,
    result,
    {
      entityType: "Product",
      identifier: { id: productData.id, name: productData.name },
    },
  );
};

export const getProductByID = async (db: Database, id: ProductId) => {
  const res = await getDb(db).query.product.findFirst({
    where: eq(product.id, id),
    ...relations.product.full,
  });

  if (!res) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
  }

  return dbProductToAPI(res);
};

/**
 * Find a product by its shortcode
 * Returns null if not found
 */
export const findProductByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<ProductId | null> => {
  const prod = await getDb(db).query.product.findFirst({
    where: eq(product.shortcode, shortcode.toUpperCase()),
  });
  return prod ? unsafeProductId(prod.id) : null;
};

/**
 * Get full product details by shortcode
 */
export const getProductByShortcode = async (
  db: Database,
  shortcode: string,
) => {
  const productId = await findProductByShortcode(db, shortcode);
  if (!productId) {
    return null;
  }
  return getProductByID(db, productId);
};

export const productList = async (
  db: Database,
  name: string | undefined,
  manufacturer: string | undefined,
  upc: string | undefined,
  category: ProductCategory | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  // Build where conditions
  const conditions: ReturnType<typeof eq>[] = [];

  if (name !== undefined) {
    const nameCondition = formatSearchTerm(product.name, name);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  if (manufacturer !== undefined) {
    const manufacturerCondition = formatSearchTerm(
      product.manufacturer,
      manufacturer,
    );
    if (manufacturerCondition) {
      conditions.push(manufacturerCondition);
    }
  }

  if (upc !== undefined) {
    const upcCondition = formatSearchTerm(product.upc, upc);
    if (upcCondition) {
      conditions.push(upcCondition);
    }
  }

  if (category !== undefined) {
    // Exact match for category (enum value)
    conditions.push(eq(product.category, category));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Build order by using central sortableFields config
  const orderByArray = buildOrderBy(product, sort, [
    ...getSortableFields("product"),
  ]);

  const { take, skip } = buildTakeSkip(pagination);

  // Execute queries in parallel and transform results
  const { data: results, count: totalCount } = await executeListQueryWithCount(
    getDb(db).query.product.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.product.full,
    }),
    getDb(db).select({ count: count() }).from(product).where(whereClause),
  );

  const products = results.map((prod: ProductDeepDB) => dbProductToAPI(prod));

  return { data: products, count: totalCount };
};

// Create a new product
export const createProduct = async (
  db: Database,
  data: ProductCreateInput,
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const { ingredientId, unitMappings, pendingImageIds, ...productData } = data;

  // Auto-correct category to "food" if product has food indicators
  const category = hasFoodIndicators({ ...data, ingredientId })
    ? "food"
    : (data.category ?? null);

  // Generate unique shortcode
  const shortcode = await generateUniqueProductShortcode(db);

  // Use a transaction to ensure atomicity
  return await withTransaction(db, async (tx) => {
    // Create the product first
    const newProduct = await insertAndReturn(tx, product, {
      ...productData,
      category,
      shortcode,
      ingredientId: ingredientId ?? null,
    });

    // If there are unit mappings, create them and sync price
    if (unitMappings && unitMappings.length > 0) {
      await tx.insert(productUnitMappings).values(
        unitMappings.map((mapping) => ({
          productId: newProduct.id,
          a: mapping.a,
          b: mapping.b,
          source: mapping.source,
        })),
      );

      // Sync the product price from the newly created mappings
      await syncProductPrice(tx, unsafeProductId(newProduct.id));
    }

    // Associate images if provided
    let images: Array<typeof image.$inferSelect> = [];
    if (pendingImageIds && pendingImageIds.length > 0) {
      await associatePendingImages(
        tx,
        productImage,
        "productId",
        newProduct.id,
        pendingImageIds,
      );

      // Fetch the associated images
      images = await tx
        .select()
        .from(image)
        .where(inArray(image.id, pendingImageIds));
    }

    // Log audit entry
    await logAuditEntry(tx, actor, {
      entityType: "product",
      entityId: newProduct.id,
      action: "create",
    });

    // Construct and validate the response object
    const result = {
      ...newProduct,
      images,
    };

    return parseWithContext(productTopLevelOut, result, {
      entityType: "Product",
      identifier: { id: newProduct.id, name: newProduct.name },
    });
  });
};

// Update an existing product
export const updateProduct = async (
  db: Database,
  id: ProductId,
  data: Partial<ProductCreateInput>,
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const {
    ingredientId,
    unitMappings,
    pendingImageIds,
    removeImageIds,
    ...productData
  } = data;

  // Use a transaction to ensure atomicity
  return await withTransaction(db, async (tx) => {
    // Fetch current state for audit logging
    const beforeProduct = await tx.query.product.findFirst({
      where: eq(product.id, id),
    });

    if (!beforeProduct) {
      throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
    }

    // Build update data
    const updateData: {
      name?: string;
      manufacturer?: string;
      category?: ProductCategory | null;
      upc?: string | null;
      ndb_number?: number | null;
      model?: string | null;
      expectedQuantity?: number | null;
      ingredientId?: string | null;
    } = { ...productData };

    // Handle ingredient relationship
    if (ingredientId !== undefined) {
      updateData.ingredientId = ingredientId;
    }

    // Auto-correct category to "food" if the resulting product will have food indicators
    const resultingProduct = {
      upc: updateData.upc ?? beforeProduct.upc,
      ndb_number: updateData.ndb_number ?? beforeProduct.ndb_number,
      ingredientId: updateData.ingredientId ?? beforeProduct.ingredientId,
    };
    if (
      hasFoodIndicators(resultingProduct) &&
      beforeProduct.category !== "food"
    ) {
      updateData.category = "food";
    }

    // Update the product (updateAndReturn handles empty values gracefully)
    const updated = await updateAndReturn(
      tx,
      product,
      updateData,
      eq(product.id, id),
    );

    const productId = id;

    // If unitMappings is provided, handle the updates efficiently
    if (unitMappings !== undefined) {
      // Get existing mappings
      const existingMappings = await tx.query.productUnitMappings.findMany({
        where: eq(productUnitMappings.productId, productId),
      });

      // Find mappings to delete (exist in DB but not in new data)
      const toDelete = existingMappings.filter(
        (m: typeof productUnitMappings.$inferSelect) =>
          !unitMappings.some((um) => um.id === m.id),
      );

      // Find mappings to create (exist in new data but not in DB)
      const toCreate = unitMappings.filter(
        (m: (typeof unitMappings)[number]) => m.id === undefined,
      );

      // Find mappings to update (exist in both)
      const toUpdate = unitMappings.filter(
        (m): m is typeof m & { id: string } => m.id !== undefined,
      );

      // Delete removed mappings
      if (toDelete.length > 0) {
        await tx.delete(productUnitMappings).where(
          inArray(
            productUnitMappings.id,
            toDelete.map((m) => m.id),
          ),
        );
      }

      // Create new mappings
      if (toCreate.length > 0) {
        await tx.insert(productUnitMappings).values(
          toCreate.map((mapping) => ({
            productId,
            a: mapping.a,
            b: mapping.b,
            source: mapping.source,
          })),
        );
      }

      // Update existing mappings
      for (const mapping of toUpdate) {
        await tx
          .update(productUnitMappings)
          .set({
            a: mapping.a,
            b: mapping.b,
            source: mapping.source,
          })
          .where(eq(productUnitMappings.id, mapping.id));
      }

      // Sync the product price after all unit mapping changes
      await syncProductPrice(tx, productId);
    }

    // Add new images if provided
    if (pendingImageIds && pendingImageIds.length > 0) {
      await associatePendingImages(
        tx,
        productImage,
        "productId",
        updated.id,
        pendingImageIds,
      );
    }

    // Remove images if requested
    if (removeImageIds && removeImageIds.length > 0) {
      await tx
        .delete(productImage)
        .where(
          and(
            eq(productImage.productId, updated.id),
            inArray(productImage.imageId, removeImageIds),
          ),
        );
    }

    // Fetch all associated images
    const productImages = await tx.query.productImage.findMany({
      where: eq(productImage.productId, updated.id),
      with: {
        image: true,
      },
    });

    // Log audit entry with changes
    const changes = computeChanges(beforeProduct, updated, [
      "name",
      "manufacturer",
      "category",
      "upc",
      "ndb_number",
      "model",
      "expectedQuantity",
      "ingredientId",
    ]);

    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: updated.id,
        action: "update",
        changes,
      });
    }

    // Construct and validate the response object
    const result = {
      ...updated,
      images: extractImagesFromJoinTable(productImages),
    };

    return parseWithContext(productTopLevelOut, result, {
      entityType: "Product",
      identifier: { id: updated.id, name: updated.name },
    });
  });
};

// Find a product by UPC code
export const findProductByUPC = async (
  db: Database,
  upcCode: string,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where: eq(product.upc, upcCode),
    with: {
      images: {
        with: {
          image: true,
        },
      },
    },
  });

  if (!res) {
    return null;
  }

  return parseWithContext(
    productTopLevelOut,
    {
      ...res,
      images: extractImagesFromJoinTable(res.images),
    },
    {
      entityType: "Product",
      identifier: { id: res.id, name: res.name },
    },
  );
};

// Find a product by name and manufacturer (internal helper)
const findProductByNameAndManufacturer = async (
  db: Database,
  name: string,
  manufacturer: string,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where: and(
      ilike(product.name, name),
      ilike(product.manufacturer, manufacturer),
    ),
    with: {
      images: {
        with: {
          image: true,
        },
      },
    },
  });

  if (!res) {
    return null;
  }

  return parseWithContext(
    productTopLevelOut,
    {
      ...res,
      images: extractImagesFromJoinTable(res.images),
    },
    {
      entityType: "Product",
      identifier: { id: res.id, name: res.name },
    },
  );
};

/**
 * Find a product by name with fuzzy manufacturer matching
 *
 * Matching logic:
 * - If incoming manufacturer is unspecified → match by name only (any manufacturer)
 * - If incoming manufacturer is specific → try exact match first, then fallback
 *   to matching a product with "(unspecified)" manufacturer in DB
 *
 * This allows sheet rows with empty manufacturer to match existing products
 * regardless of their manufacturer, while specific manufacturers require
 * exact match or fallback to unspecified.
 */
export const findProductByNameFuzzyManufacturer = async (
  db: Database,
  name: string,
  manufacturer: string | null | undefined,
): Promise<ProductTopLevelOut | null> => {
  // If incoming manufacturer is unspecified, match by name only
  if (isUnspecifiedManufacturer(manufacturer)) {
    const res = await getDb(db).query.product.findFirst({
      where: ilike(product.name, name),
      with: {
        images: {
          with: {
            image: true,
          },
        },
      },
    });

    if (!res) {
      return null;
    }

    return parseWithContext(
      productTopLevelOut,
      {
        ...res,
        images: extractImagesFromJoinTable(res.images),
      },
      {
        entityType: "Product",
        identifier: { id: res.id, name: res.name },
      },
    );
  }

  // Incoming manufacturer is specific - try exact match first
  const exactMatch = await findProductByNameAndManufacturer(
    db,
    name,
    manufacturer!,
  );

  if (exactMatch) {
    return exactMatch;
  }

  // Fallback: try to match a product with "(unspecified)" manufacturer
  const unspecifiedMatch = await getDb(db).query.product.findFirst({
    where: and(
      ilike(product.name, name),
      ilike(product.manufacturer, UNSPECIFIED_MANUFACTURER),
    ),
    with: {
      images: {
        with: {
          image: true,
        },
      },
    },
  });

  if (!unspecifiedMatch) {
    return null;
  }

  return parseWithContext(
    productTopLevelOut,
    {
      ...unspecifiedMatch,
      images: extractImagesFromJoinTable(unspecifiedMatch.images),
    },
    {
      entityType: "Product",
      identifier: { id: unspecifiedMatch.id, name: unspecifiedMatch.name },
    },
  );
};

// Quick create a product with minimal data
export const quickCreateProduct = async (
  db: Database,
  data: {
    name: string;
    manufacturer?: string;
    upc?: string | null;
    expectedQuantity?: number | null;
    model?: string | null;
    ndb_number?: number | null;
    ingredientId?: string | null;
    price?: number | null;
    category?: ProductCategory | null;
    // Timestamps (optional, for preserving through sync)
    createdAt?: Date;
    updatedAt?: Date;
  },
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  // Auto-correct category to "food" if product has food indicators
  const category = hasFoodIndicators(data) ? "food" : (data.category ?? null);

  // Generate unique shortcode
  const shortcode = await generateUniqueProductShortcode(db);

  const newProduct = await insertAndReturnDb(db, product, {
    name: data.name,
    manufacturer: data.manufacturer ?? UNSPECIFIED_MANUFACTURER,
    upc: data.upc ?? null,
    ndb_number: data.ndb_number ?? null,
    model: data.model ?? null,
    expectedQuantity: data.expectedQuantity ?? null,
    ingredientId: data.ingredientId ?? null,
    category,
    shortcode,
    // Preserve timestamps if provided (for sync restore)
    ...(data.createdAt && { createdAt: data.createdAt }),
    ...(data.updatedAt && { updatedAt: data.updatedAt }),
  });

  // Create price unit mapping if price is provided
  if (data.price != null) {
    await createOrUpdatePriceMapping(
      db,
      unsafeProductId(newProduct.id),
      { value: data.price, unit: "dollar" },
      "quick-create",
    );
  }

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "product",
    entityId: newProduct.id,
    action: "create",
  });

  return parseWithContext(
    productTopLevelOut,
    {
      ...newProduct,
      images: [],
    },
    {
      entityType: "Product",
      identifier: { id: newProduct.id, name: newProduct.name },
    },
  );
};

// Find products with expectedQuantity=1 that appear in multiple locations
export const findDuplicateUniqueProducts = async (db: Database) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: eq(product.expectedQuantity, 1),
    with: {
      InventoryEntry: {
        with: {
          location: true,
        },
      },
    },
  });

  return duplicates.filter((prod) => prod.InventoryEntry.length > 1);
};

/**
 * Find all products that have a UPC but no UPC-fetched image.
 * Products may have other images (user-uploaded), but are missing the UPC image.
 * Used for UPC image backfill functionality.
 */
export const findProductsWithUPCNoImages = async (
  db: Database,
): Promise<
  Array<{ id: string; name: string; manufacturer: string; upc: string }>
> => {
  const dbClient = getDb(db);

  // Get all products with UPCs and their images in a single query
  const productsWithImages = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      upc: product.upc,
      imageUrl: image.url,
    })
    .from(product)
    .leftJoin(productImage, eq(productImage.productId, product.id))
    .leftJoin(image, eq(productImage.imageId, image.id))
    .where(and(isNotNull(product.upc), isNull(product.deletedAt)));

  // Group by product and check for UPC images
  const productMap = new Map<
    string,
    { name: string; manufacturer: string; upc: string; hasUPCImage: boolean }
  >();

  for (const row of productsWithImages) {
    if (!row.upc) continue;

    const existing = productMap.get(row.id);
    const isUPCImage = row.imageUrl?.includes("/upc-") ?? false;

    if (existing) {
      // Update if this row has a UPC image
      if (isUPCImage) {
        existing.hasUPCImage = true;
      }
    } else {
      productMap.set(row.id, {
        name: row.name,
        manufacturer: row.manufacturer,
        upc: row.upc,
        hasUPCImage: isUPCImage,
      });
    }
  }

  // Return products without UPC images
  const results: Array<{
    id: string;
    name: string;
    manufacturer: string;
    upc: string;
  }> = [];
  for (const [id, data] of productMap) {
    if (!data.hasUPCImage) {
      results.push({
        id,
        name: data.name,
        manufacturer: data.manufacturer,
        upc: data.upc,
      });
    }
  }

  return results;
};

/**
 * Find all products that have food indicators (UPC, NDB, or ingredient) but category is not "food".
 * Used for food category backfill functionality.
 */
export const findProductsNeedingFoodCategory = async (
  db: Database,
): Promise<
  Array<{
    id: string;
    name: string;
    manufacturer: string;
    category: string | null;
    upc: string | null;
    ndb_number: number | null;
    ingredientId: string | null;
  }>
> => {
  const dbClient = getDb(db);

  // Find products with food indicators but wrong category
  const products = await dbClient.query.product.findMany({
    where: isNull(product.deletedAt),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      category: true,
      upc: true,
      ndb_number: true,
      ingredientId: true,
    },
  });

  // Filter to products with food indicators but wrong category
  return products.filter((p) => hasFoodIndicators(p) && p.category !== "food");
};

/**
 * Get product distribution by category with top locations for each category.
 * Used for the category donut visualization on the Insights page.
 */
export const getCategoryDistribution = async (
  db: Database,
): Promise<
  Array<{
    category: ProductCategory | null;
    productCount: number;
    locations: Array<{ id: string; name: string; count: number }>;
  }>
> => {
  const dbClient = getDb(db);

  // Get all products with their inventory locations
  const productsWithInventory = await dbClient.query.product.findMany({
    where: isNull(product.deletedAt),
    columns: {
      id: true,
      category: true,
    },
    with: {
      InventoryEntry: {
        columns: {},
        with: {
          location: {
            columns: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  // Group by category and aggregate
  const categoryMap = new Map<
    ProductCategory | null,
    {
      productCount: number;
      locationCounts: Map<string, { id: string; name: string; count: number }>;
    }
  >();

  for (const prod of productsWithInventory) {
    const cat = prod.category as ProductCategory | null;

    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, {
        productCount: 0,
        locationCounts: new Map(),
      });
    }

    const catData = categoryMap.get(cat)!;
    catData.productCount++;

    // Count locations for this product
    for (const entry of prod.InventoryEntry) {
      const loc = entry.location;
      const existing = catData.locationCounts.get(loc.id);
      if (existing) {
        existing.count++;
      } else {
        catData.locationCounts.set(loc.id, {
          id: loc.id,
          name: loc.name,
          count: 1,
        });
      }
    }
  }

  // Convert to array and sort locations by count (top 5)
  const result: Array<{
    category: ProductCategory | null;
    productCount: number;
    locations: Array<{ id: string; name: string; count: number }>;
  }> = [];

  for (const [category, data] of categoryMap) {
    const locations = Array.from(data.locationCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    result.push({
      category,
      productCount: data.productCount,
      locations,
    });
  }

  // Sort by product count descending
  result.sort((a, b) => b.productCount - a.productCount);

  return result;
};

/**
 * Backfill food category for all products with food indicators.
 * Returns the count of products updated.
 */
export const backfillFoodCategories = async (
  db: Database,
  actor: ActorContext,
): Promise<{
  updated: number;
  products: Array<{ id: string; name: string }>;
}> => {
  const productsToUpdate = await findProductsNeedingFoodCategory(db);

  if (productsToUpdate.length === 0) {
    return { updated: 0, products: [] };
  }

  const dbClient = getDb(db);
  const productIds = productsToUpdate.map((p) => p.id);

  // Batch update all products to category = "food"
  await dbClient
    .update(product)
    .set({ category: "food" })
    .where(inArray(product.id, productIds));

  // Log audit entries for each update
  for (const p of productsToUpdate) {
    await logAuditEntry(db, actor, {
      entityType: "product",
      entityId: p.id,
      action: "update",
      changes: {
        category: { from: p.category, to: "food" },
      },
    });
  }

  return {
    updated: productsToUpdate.length,
    products: productsToUpdate.map((p) => ({ id: p.id, name: p.name })),
  };
};

/**
 * Sync the price column for a product by recomputing from unit mappings.
 * Also syncs valuation for all inventory entries of this product.
 * This is the single function that should be called whenever unit mappings change.
 */
export const syncProductPrice = async (
  tx: DrizzleTransaction,
  productId: ProductId,
): Promise<void> => {
  // Fetch all unit mappings for this product
  const mappings = await tx.query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  // Compute the price using WASM (single source of truth)
  const price = computeProductPrice(mappings);

  // Update the product's price column
  await tx.update(product).set({ price }).where(eq(product.id, productId));

  // Update valuations for all inventory entries of this product
  await syncInventoryValuationsForProduct(tx, productId);
};

/**
 * Find all products that have stale or missing prices.
 * A price is stale if the computed price from unit mappings differs from the stored price.
 * A price is missing if the product has price mappings but no stored price.
 */
export const findProductsWithStalePrices = async (
  db: Database,
): Promise<
  Array<{
    id: string;
    name: string;
    manufacturer: string;
    storedPrice: number | null;
    computedPrice: number | null;
    status: "missing" | "stale";
  }>
> => {
  const dbClient = getDb(db);

  // Get all products with their unit mappings
  const productsWithMappings = await dbClient.query.product.findMany({
    where: isNull(product.deletedAt),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      price: true,
    },
    with: {
      unitMappings: true,
    },
  });

  const results: Array<{
    id: string;
    name: string;
    manufacturer: string;
    storedPrice: number | null;
    computedPrice: number | null;
    status: "missing" | "stale";
  }> = [];

  for (const prod of productsWithMappings) {
    const computedPrice = computeProductPrice(prod.unitMappings);
    const storedPrice = prod.price;

    // Skip if both are null (no price mapping, no stored price)
    if (computedPrice === null && storedPrice === null) {
      continue;
    }

    // Check if price is missing or stale
    if (computedPrice !== null && storedPrice === null) {
      results.push({
        id: prod.id,
        name: prod.name,
        manufacturer: prod.manufacturer,
        storedPrice,
        computedPrice,
        status: "missing",
      });
    } else if (
      computedPrice !== null &&
      storedPrice !== null &&
      Math.abs(computedPrice - storedPrice) > 0.001
    ) {
      results.push({
        id: prod.id,
        name: prod.name,
        manufacturer: prod.manufacturer,
        storedPrice,
        computedPrice,
        status: "stale",
      });
    }
  }

  return results;
};

/**
 * Backfill product prices from unit mappings.
 * Updates all products with missing or stale prices.
 */
export const backfillProductPrices = async (
  db: Database,
  actor: ActorContext,
): Promise<{
  updated: number;
  products: Array<{
    id: string;
    name: string;
    oldPrice: number | null;
    newPrice: number | null;
  }>;
}> => {
  const productsToUpdate = await findProductsWithStalePrices(db);

  if (productsToUpdate.length === 0) {
    return { updated: 0, products: [] };
  }

  return await withTransaction(db, async (tx) => {
    const updatedProducts: Array<{
      id: string;
      name: string;
      oldPrice: number | null;
      newPrice: number | null;
    }> = [];

    for (const prod of productsToUpdate) {
      // Update the product's price
      await tx
        .update(product)
        .set({ price: prod.computedPrice })
        .where(eq(product.id, prod.id));

      // Log audit entry
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: prod.id,
        action: "update",
        changes: {
          price: { from: prod.storedPrice, to: prod.computedPrice },
        },
      });

      updatedProducts.push({
        id: prod.id,
        name: prod.name,
        oldPrice: prod.storedPrice,
        newPrice: prod.computedPrice,
      });
    }

    return {
      updated: updatedProducts.length,
      products: updatedProducts,
    };
  });
};
