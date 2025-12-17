import { type Database, type Transaction } from "~/server/db";
import { createOrUpdatePriceMapping } from "./inventory";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";
import { foodLookupParam, FoodLookupParam } from "@recipehub/usda-schemas";
import {
  type ProductTopLevelOut,
  type ProductInputPayload,
  productTopLevelOut,
} from "~/schemas/product";
import {
  UNSPECIFIED_MANUFACTURER,
  DEFAULT_EXPECTED_QUANTITY,
} from "~/lib/constants";
import {
  formatSearchTerm,
  getDb,
  unwrapDb,
  relations,
  buildOrderBy,
  updateAndReturn,
  extractImagesFromJoinTable,
  mapRelation,
  addProductSourceMetadata,
  associatePendingImages,
  executeListQueryWithCount,
} from "~/server/repo/database-helpers";
import {
  notFoundByNameError,
  ambiguousNameError,
  notFoundError,
} from "~/lib/error-messages";
import {
  type ProductId,
  type OrganizationId,
  unsafeLocationId,
  unsafeProductId,
} from "~/schemas/identifiers";
import {
  product,
  productUnitMappings,
  ingredient,
  inventoryEntry,
  location,
  image,
  productImage,
} from "~/server/db/schema";
import { eq, and, count, ilike, inArray } from "drizzle-orm";
import { logAuditEntry, computeChanges } from "~/server/repo/audit-log";

export const findProductByName = async (
  db: Database | Transaction,
  name: string,
): Promise<typeof product.$inferSelect> => {
  const p = await unwrapDb(db).query.product.findMany({
    where: ilike(product.name, name),
  });

  switch (p.length) {
    case 0:
      throw new Error(notFoundByNameError("Product", name));
    case 1:
      return p[0];
    default:
      throw new Error(ambiguousNameError("product", name));
  }
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
export const foodLookupParamFromProduct = (product: {
  upc: string | null;
  ndb_number: number | null;
}): FoodLookupParam | null => {
  if (product.upc !== null) {
    return { kind: "upc", gtin_upc: product.upc };
  }
  if (product.ndb_number !== null) {
    return { kind: "ndb", ndb_number: product.ndb_number };
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
    images: p.images?.map((pi) => pi.image) ?? [],
  }));
};

const dbProductToAPI = async (
  db: Database,
  productData: ProductDeepDB,
): Promise<z.infer<typeof productWithIngredientAndInventoryAndMappingsOut>> => {
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

  // Use Zod parse to validate the transformation
  return productWithIngredientAndInventoryAndMappingsOut.parse(result);
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
    throw new Error(notFoundError("Product", id));
  }

  return dbProductToAPI(db, res);
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

  const products = await Promise.all(
    results.map(async (prod: ProductDeepDB) => await dbProductToAPI(db, prod)),
  );

  return { data: products, count: totalCount };
};

// Create a new product
export const createProduct = async (
  db: Database,
  data: ProductInputPayload,
  organizationId: OrganizationId,
  userId: string,
): Promise<ProductTopLevelOut> => {
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
    await logAuditEntry(tx, {
      organizationId,
      entityType: "product",
      entityId: newProduct.id,
      action: "create",
      userId,
    });

    // Construct and validate the response object
    const result = {
      ...newProduct,
      images,
    };

    return productTopLevelOut.parse(result);
  });
};

// Update an existing product
export const updateProduct = async (
  db: Database,
  id: ProductId,
  organizationId: OrganizationId,
  data: Partial<ProductInputPayload>,
  userId: string,
): Promise<ProductTopLevelOut> => {
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
      throw new Error(notFoundError("Product", id));
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

    // Update the product
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
      await logAuditEntry(tx, {
        organizationId,
        entityType: "product",
        entityId: updated.id,
        action: "update",
        changes,
        userId,
      });
    }

    // Construct and validate the response object
    const result = {
      ...updated,
      images: productImages.map((pi) => pi.image),
    };

    return productTopLevelOut.parse(result);
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

  return productTopLevelOut.parse({
    ...res,
    images: res.images?.map((pi) => pi.image) ?? [],
  });
};

// Find a product by UPC (global uniqueness) within an organization
export const findProductByUpc = async (
  db: Database,
  upc: string,
  organizationId: OrganizationId,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where: and(
      eq(product.upc, upc),
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

  return productTopLevelOut.parse({
    ...res,
    images: res.images?.map((pi) => pi.image) ?? [],
  });
};

// Find a product by name and manufacturer within an organization
export const findProductByNameAndManufacturer = async (
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

  return productTopLevelOut.parse({
    ...res,
    images: res.images?.map((pi) => pi.image) ?? [],
  });
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
  organizationId: OrganizationId,
  userId: string,
): Promise<ProductTopLevelOut> => {
  const [newProduct] = await getDb(db)
    .insert(product)
    .values({
      organizationId: organizationId,
      name: data.name,
      manufacturer: data.manufacturer ?? UNSPECIFIED_MANUFACTURER,
      upc: data.upc ?? null,
      ndb_number: data.ndb_number ?? null,
      model: data.model ?? null,
      expectedQuantity: data.expectedQuantity ?? DEFAULT_EXPECTED_QUANTITY,
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
  await logAuditEntry(db, {
    organizationId,
    entityType: "product",
    entityId: newProduct.id,
    action: "create",
    userId,
  });

  return productTopLevelOut.parse({
    ...newProduct,
    images: [],
  });
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
