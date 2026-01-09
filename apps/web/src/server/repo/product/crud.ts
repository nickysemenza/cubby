/**
 * Product CRUD operations.
 * Core create, read, update, list operations for products.
 */

import { and, count, eq, inArray } from "drizzle-orm";

import { getSortableFields } from "~/entities/entities";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { parseWithContext } from "~/lib/zod-utils";
import type { ActorContext } from "~/schemas/context";
import { type ProductId, unsafeProductId } from "~/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/pagination";
import {
  hasFoodIndicators,
  type ProductCategory,
  type ProductCreateInput,
  type ProductTopLevelOut,
  productTopLevelOut,
} from "~/schemas/product";
import { createAppError } from "~/server/api/trpc";
import type { Database } from "~/server/db";
import {
  image,
  product,
  productImage,
  productUnitMappings,
} from "~/server/db/schema";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  associatePendingImages,
  buildOrderBy,
  executeListQueryWithCount,
  extractImagesFromJoinTable,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  insertAndReturnDb,
  relations,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createOrUpdatePriceMapping } from "~/server/repo/inventory/csv-import/index";
import { generateUniqueProductShortcode } from "~/server/repo/shortcode-utils";

import { dbProductToAPI } from "./helpers";
import { syncProductPrice } from "./pricing";
import type { ProductDeepDB } from "./types";

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
