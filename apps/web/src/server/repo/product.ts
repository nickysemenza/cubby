import type { Database, Transaction } from "~/server/db";
import { createOrUpdatePriceMapping } from "./inventory";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";
import { foodLookupParam, type FoodLookupParam } from "@recipehub/usda-schemas";
import {
  type ProductTopLevelOut,
  type ProductInputPayload,
  productTopLevelOut,
} from "~/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import {
  formatSearchTerm,
  getDb,
  relations,
  buildOrderBy,
  updateAndReturn,
  extractImagesFromJoinTable,
  mapRelation,
  addProductSourceMetadata,
  associatePendingImages,
  executeListQueryWithCount,
} from "~/server/repo/database-helpers";
import { createAppError } from "~/server/api/trpc";
import {
  type ProductId,
  type OrganizationId,
  unsafeLocationId,
  unsafeProductId,
} from "~/schemas/identifiers";
import {
  product,
  productUnitMappings,
  type ingredient,
  type inventoryEntry,
  type location,
  image,
  productImage,
} from "~/server/db/schema";
import { eq, and, count, ilike, inArray, isNotNull, isNull } from "drizzle-orm";
import { logAuditEntry, computeChanges } from "~/server/repo/audit-log";
import type { ActorContext } from "~/schemas/context";

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
    images: extractImagesFromJoinTable(p.images),
  }));
};

const dbProductToAPI = (
  productData: ProductDeepDB,
): z.infer<typeof productWithIngredientAndInventoryAndMappingsOut> => {
  const { Ingredient, unitMappings, InventoryEntry, images, ...restOfProduct } =
    productData;

  const result = {
    ...restOfProduct,
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

export const getProductByID = async (
  db: Database,
  id: ProductId,
  organizationId: OrganizationId,
) => {
  const res = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, id), eq(product.organizationId, organizationId)),
    ...relations.product.full,
  });

  if (!res) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
  }

  return dbProductToAPI(res);
};

export const productList = async (
  db: Database,
  organizationId: OrganizationId,
  name: string | undefined,
  manufacturer: string | undefined,
  upc: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  // Build where conditions
  const conditions = [eq(product.organizationId, organizationId)];

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

  const whereClause = and(...conditions);

  // Build order by
  const orderByArray = buildOrderBy(product, sort, [
    "createdAt",
    "name",
    "manufacturer",
    "model",
    "upc",
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
  data: ProductInputPayload,
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const { organizationId } = actor;
  const { ingredientId, unitMappings, pendingImageIds, ...productData } = data;

  // Use a transaction to ensure atomicity
  return await getDb(db).transaction(async (tx: Transaction) => {
    // Create the product first
    const [newProduct] = await tx
      .insert(product)
      .values({
        organizationId: organizationId,
        ...productData,
        ingredientId: ingredientId ?? null,
      })
      .returning();

    if (!newProduct) {
      throw new Error("Failed to create product");
    }

    // If there are unit mappings, create them
    if (unitMappings && unitMappings.length > 0) {
      await tx.insert(productUnitMappings).values(
        unitMappings.map((mapping) => ({
          productId: newProduct.id,
          a: mapping.a,
          b: mapping.b,
          source: mapping.source,
        })),
      );
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
  data: Partial<ProductInputPayload>,
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const { organizationId } = actor;
  const {
    ingredientId,
    unitMappings,
    pendingImageIds,
    removeImageIds,
    ...productData
  } = data;

  // Use a transaction to ensure atomicity
  return await getDb(db).transaction(async (tx: Transaction) => {
    // Fetch current state for audit logging
    const beforeProduct = await tx.query.product.findFirst({
      where: and(
        eq(product.id, id),
        eq(product.organizationId, organizationId),
      ),
    });

    if (!beforeProduct) {
      throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
    }

    // Build update data
    const updateData: {
      name?: string;
      manufacturer?: string;
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

    // Update the product (updateAndReturn handles empty values gracefully)
    const updated = await updateAndReturn(
      tx,
      product,
      updateData,
      and(eq(product.id, id), eq(product.organizationId, organizationId)),
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

// Find a product by UPC code within an organization
export const findProductByUPC = async (
  db: Database,
  upcCode: string,
  organizationId: OrganizationId,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where: and(
      eq(product.upc, upcCode),
      eq(product.organizationId, organizationId),
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

// Find a product by name and manufacturer within an organization (internal helper)
const findProductByNameAndManufacturer = async (
  db: Database,
  name: string,
  manufacturer: string,
  organizationId: OrganizationId,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where: and(
      ilike(product.name, name),
      ilike(product.manufacturer, manufacturer),
      eq(product.organizationId, organizationId),
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
  organizationId: OrganizationId,
): Promise<ProductTopLevelOut | null> => {
  // If incoming manufacturer is unspecified, match by name only
  if (isUnspecifiedManufacturer(manufacturer)) {
    const res = await getDb(db).query.product.findFirst({
      where: and(
        ilike(product.name, name),
        eq(product.organizationId, organizationId),
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
  }

  // Incoming manufacturer is specific - try exact match first
  const exactMatch = await findProductByNameAndManufacturer(
    db,
    name,
    manufacturer!,
    organizationId,
  );

  if (exactMatch) {
    return exactMatch;
  }

  // Fallback: try to match a product with "(unspecified)" manufacturer
  const unspecifiedMatch = await getDb(db).query.product.findFirst({
    where: and(
      ilike(product.name, name),
      ilike(product.manufacturer, UNSPECIFIED_MANUFACTURER),
      eq(product.organizationId, organizationId),
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
  },
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const { organizationId } = actor;
  const [newProduct] = await getDb(db)
    .insert(product)
    .values({
      organizationId: organizationId,
      name: data.name,
      manufacturer: data.manufacturer ?? UNSPECIFIED_MANUFACTURER,
      upc: data.upc ?? null,
      ndb_number: data.ndb_number ?? null,
      model: data.model ?? null,
      expectedQuantity: data.expectedQuantity ?? null,
      ingredientId: data.ingredientId ?? null,
    })
    .returning();

  if (!newProduct) {
    throw new Error("Failed to create product");
  }

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
export const findDuplicateUniqueProducts = async (
  db: Database,
  organizationId: OrganizationId,
) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: and(
      eq(product.organizationId, organizationId),
      eq(product.expectedQuantity, 1),
    ),
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
  organizationId: OrganizationId,
): Promise<Array<{ id: string; name: string; upc: string }>> => {
  const dbClient = getDb(db);

  // Get all products with UPCs and their images in a single query
  const productsWithImages = await dbClient
    .select({
      id: product.id,
      name: product.name,
      upc: product.upc,
      imageUrl: image.url,
    })
    .from(product)
    .leftJoin(productImage, eq(productImage.productId, product.id))
    .leftJoin(image, eq(productImage.imageId, image.id))
    .where(
      and(
        eq(product.organizationId, organizationId),
        isNotNull(product.upc),
        isNull(product.deletedAt),
      ),
    );

  // Group by product and check for UPC images
  const productMap = new Map<
    string,
    { name: string; upc: string; hasUPCImage: boolean }
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
        upc: row.upc,
        hasUPCImage: isUPCImage,
      });
    }
  }

  // Return products without UPC images
  const results: Array<{ id: string; name: string; upc: string }> = [];
  for (const [id, data] of productMap) {
    if (!data.hasUPCImage) {
      results.push({ id, name: data.name, upc: data.upc });
    }
  }

  return results;
};
