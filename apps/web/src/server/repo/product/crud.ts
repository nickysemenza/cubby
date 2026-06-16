/**
 * Product CRUD operations.
 * Core create, read, update, list operations for products.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  hasFoodIndicators,
  type ProductCategory,
  type ProductCreateInput,
  type ProductTopLevelOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { getSortableFields } from "~/entities/entities";
import { parseWithContext } from "~/lib/zod-utils";
import type { Database } from "~/server/db";
import {
  image,
  inventoryEntry,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  associatePendingImages,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  extractImagesFromJoinTable,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";
import { generateUniqueProductShortcode } from "~/server/repo/shortcode-utils";

import { dbProductToAPI } from "./helpers";
import type { ProductDeepDB } from "./types";
import {
  assertNoCanonicalPriceMapping,
  syncProductExternalIds,
  syncProductImages,
  syncProductUnitMappings,
} from "./update-helpers";

export const getProductByID = async (db: Database, id: ProductId) => {
  const res = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, id), notDeleted(product)),
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
const findProductByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<ProductId | null> => {
  const prod = await getDb(db).query.product.findFirst({
    where: and(
      eq(product.shortcode, shortcode.toUpperCase()),
      notDeleted(product),
    ),
  });
  return prod ? prod.id : null;
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

/**
 * Fetch multiple products by shortcodes in a single query.
 * Returns basic product data (suitable for labels).
 */
export const getProductsByShortcodes = async (
  db: Database,
  shortcodes: string[],
) => {
  if (shortcodes.length === 0) return [];
  const uppercased = shortcodes.map((s) => s.toUpperCase());
  const results = await getDb(db).query.product.findMany({
    where: and(inArray(product.shortcode, uppercased), notDeleted(product)),
    ...relations.product.full,
  });
  return results.map(dbProductToAPI);
};

export const productList = async (
  db: Database,
  name: string | undefined,
  manufacturer: string | undefined,
  upc: string | undefined,
  category: ProductCategory | undefined,
  sort: SortParams,
  pagination: PaginationParams,
  groupBy?: string,
) => {
  // Build where conditions - always filter out deleted items
  const whereClause = buildSearchConditions(
    product,
    [
      { column: product.name, term: name },
      { column: product.manufacturer, term: manufacturer },
      { column: product.upc, term: upc },
    ],
    [category !== undefined ? eq(product.category, category) : undefined],
  );

  // Build order by using central sortableFields config. `ingredient` isn't a
  // column — sort by the linked ingredient's name via a correlated subquery
  // (groupBy isn't combined with this sort in the UI). It MUST be sql.raw: the
  // relational query builder (query.product.findMany) rewrites column refs in a
  // custom orderBy to the root alias ("product"), mangling cross-table refs, so we
  // hand-qualify "Ingredient" and correlate to "product"."ingredientId". A raw
  // string is opaque to that rewriter. Everything else uses buildOrderBy.
  const orderByArray =
    sort.orderBy === "ingredient"
      ? [
          sql.raw(
            `(SELECT i."name" FROM "Ingredient" i WHERE i."id" = "product"."ingredientId") ${
              sort.direction === "asc" ? "asc nulls last" : "desc nulls last"
            }`,
          ),
        ]
      : buildOrderBy(product, sort, [...getSortableFields("product")], groupBy);

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
    countWhere(db, product, whereClause),
  );

  const products = results.map((prod: ProductDeepDB) => dbProductToAPI(prod));

  return { data: products, count: totalCount };
};

/**
 * Walk an error's `cause` chain looking for a Postgres unique-violation (23505).
 * Drizzle wraps the driver error as "Failed query: …" and hides the real cause,
 * so the raw message never says "duplicate" — we dig it out here.
 */
function findUniqueViolation(
  error: unknown,
): { constraint: string; detail: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth++) {
    if (
      typeof current === "object" &&
      (current as { code?: unknown }).code === "23505"
    ) {
      const e = current as { constraint?: unknown; detail?: unknown };
      return {
        constraint: typeof e.constraint === "string" ? e.constraint : "",
        detail: typeof e.detail === "string" ? e.detail : "",
      };
    }
    current = (current as { cause?: unknown })?.cause;
  }
  return null;
}

/**
 * Translate a Product unique-constraint violation into a clear, actionable
 * CONFLICT error (naming the conflicting product/ingredient where possible).
 * No-op if the error isn't a unique violation, so callers can rethrow.
 */
async function throwIfDuplicateProduct(
  db: Database,
  data: Pick<ProductCreateInput, "name" | "manufacturer"> & {
    upc?: string | null;
  },
  error: unknown,
): Promise<void> {
  const violation = findUniqueViolation(error);
  if (!violation) return;
  const { constraint } = violation;

  if (constraint.includes("upc") && data.upc) {
    const existing = await getDb(db).query.product.findFirst({
      where: and(eq(product.upc, data.upc), notDeleted(product)),
      columns: { name: true },
    });
    throw createAppError(
      "PRODUCT_ALREADY_EXISTS",
      `UPC ${data.upc} is already used by ${
        existing ? `product “${existing.name}”` : "another product"
      }.`,
      error,
    );
  }

  if (constraint.includes("name_manufacturer")) {
    throw createAppError(
      "PRODUCT_ALREADY_EXISTS",
      `A product named “${data.name}” by “${data.manufacturer}” already exists.`,
      error,
    );
  }

  // Unknown unique violation — still clearer than the raw SQL dump.
  throw createAppError(
    "PRODUCT_ALREADY_EXISTS",
    `This product duplicates an existing one${
      constraint ? ` (constraint ${constraint})` : ""
    }.`,
    error,
  );
}

// Create a new product
export const createProduct = async (
  db: Database,
  data: ProductCreateInput,
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const {
    ingredientId,
    unitMappings,
    externalIds,
    pendingImageIds,
    ...productData
  } = data;

  // Auto-correct category to "food" if product has food indicators
  const category = hasFoodIndicators({ ...data, ingredientId })
    ? "food"
    : (data.category ?? null);

  // Generate unique shortcode
  const shortcode = await generateUniqueProductShortcode(db);

  // Per-each price is the scalar `productData.price` column; a canonical
  // "1 each = $X" mapping would duplicate it (per-measure money mappings are OK).
  if (unitMappings) assertNoCanonicalPriceMapping(unitMappings);

  // Use a transaction to ensure atomicity. On a unique violation (e.g. another
  // product already links this USDA food/UPC), translate the raw DB error into a
  // clear CONFLICT message — the lookups run on `db` because the tx is aborted.
  try {
    return await withTransaction(db, async (tx) => {
      // Create the product first (price flows in via ...productData)
      const newProduct = await insertAndReturn(tx, product, {
        ...productData,
        category,
        shortcode,
        ingredientId: ingredientId ?? null,
      });

      // Persist measurement conversions (money-free; price lives on the column)
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

      // If there are external IDs, create them
      if (externalIds && externalIds.length > 0) {
        await tx.insert(productExternalId).values(
          externalIds.map((eid) => ({
            productId: newProduct.id,
            source: eid.source,
            externalId: eid.externalId,
            url: eid.url ?? null,
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

      // Fetch created external IDs for the response
      const createdExternalIds =
        externalIds && externalIds.length > 0
          ? await tx.query.productExternalId.findMany({
              where: eq(productExternalId.productId, newProduct.id),
            })
          : [];

      // Construct and validate the response object
      const result = {
        ...newProduct,
        images,
        externalIds: createdExternalIds,
      };

      return parseWithContext(productTopLevelOut, result, {
        entityType: "Product",
        identifier: { id: newProduct.id, name: newProduct.name },
      });
    });
  } catch (error) {
    await throwIfDuplicateProduct(db, data, error);
    throw error;
  }
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
    externalIds,
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

    // A canonical "1 each = $X" mapping duplicates the price column; reject it.
    if (unitMappings !== undefined) assertNoCanonicalPriceMapping(unitMappings);

    // Build update data (price flows in via ...productData)
    const updateData: {
      name?: string;
      manufacturer?: string;
      category?: ProductCategory | null;
      upc?: string | null;
      fdc_id?: number | null;
      model?: string | null;
      expectedQuantity?: number | null;
      ingredientId?: IngredientId | null;
      price?: number | null;
    } = { ...productData };

    // Handle ingredient relationship
    if (ingredientId !== undefined) {
      updateData.ingredientId = ingredientId;
    }

    // Auto-correct category to "food" if the resulting product will have food indicators
    const resultingProduct = {
      fdc_id: updateData.fdc_id ?? beforeProduct.fdc_id,
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

    // When price changes, resync the dependent inventory valuations (amount × price).
    if (data.price !== undefined) {
      await syncInventoryValuationsForProduct(tx, id);
    }

    // Reconcile child collections against the incoming desired state.
    if (unitMappings !== undefined) {
      await syncProductUnitMappings(tx, id, unitMappings);
    }
    if (externalIds !== undefined) {
      await syncProductExternalIds(tx, id, externalIds);
    }
    await syncProductImages(tx, id, pendingImageIds, removeImageIds);

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
      "fdc_id",
      "model",
      "expectedQuantity",
      "ingredientId",
      "price",
    ]);

    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: updated.id,
        action: "update",
        changes,
      });
    }

    // Fetch current external IDs for the response
    const currentExternalIds = await tx.query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, updated.id),
        notDeleted(productExternalId),
      ),
    });

    // Construct and validate the response object
    const result = {
      ...updated,
      images: extractImagesFromJoinTable(productImages),
      externalIds: currentExternalIds,
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
    fdc_id?: number | null;
    ingredientId?: IngredientId | null;
    price?: number | null;
    category?: ProductCategory | null;
    shortcode?: string; // Optional shortcode from import (preserves sheet shortcodes)
    // Timestamps (optional, for preserving through sync)
    createdAt?: Date;
    updatedAt?: Date;
  },
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  // Auto-correct category to "food" if product has food indicators
  const category = hasFoodIndicators(data) ? "food" : (data.category ?? null);

  // Generate unique shortcode only if not provided
  const shortcode =
    data.shortcode ?? (await generateUniqueProductShortcode(db));

  const newProduct = await insertAndReturn(db, product, {
    name: data.name,
    manufacturer: data.manufacturer ?? UNSPECIFIED_MANUFACTURER,
    upc: data.upc ?? null,
    fdc_id: data.fdc_id ?? null,
    model: data.model ?? null,
    expectedQuantity: data.expectedQuantity ?? null,
    ingredientId: data.ingredientId ?? null,
    price: data.price ?? null,
    category,
    shortcode,
    // Preserve timestamps if provided (for sync restore)
    ...(data.createdAt && { createdAt: data.createdAt }),
    ...(data.updatedAt && { updatedAt: data.updatedAt }),
  });

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

/**
 * Soft delete products by setting deletedAt timestamp.
 * Also soft deletes related unit mappings and images.
 * Throws if any product has inventory entries.
 */
export const deleteProducts = async (
  db: Database,
  ids: ProductId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    // Lock products and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, product, ids, "Product");

    // Safety check: don't delete if any product has inventory entries
    const withInventory = await tx.query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.productId, ids),
        notDeleted(inventoryEntry),
      ),
      columns: { productId: true },
    });

    if (withInventory.length > 0) {
      const failedProductIds = uniq(withInventory.map((e) => e.productId));
      const failedProducts = await tx.query.product.findMany({
        where: inArray(product.id, failedProductIds),
        columns: { id: true, name: true },
      });
      const names = failedProducts.map((p) => p.name).join(", ");
      const count = failedProducts.length;
      throw createAppError(
        "PRODUCT_HAS_INVENTORY",
        `Cannot delete ${count} product(s): ${names} have inventory entries. Remove inventory items first.`,
      );
    }

    const now = new Date();

    // Get counts of cascaded items for audit trail
    const cascadedMappings = await tx.query.productUnitMappings.findMany({
      where: inArray(productUnitMappings.productId, ids),
      columns: { id: true, productId: true },
    });

    const cascadedImages = await tx.query.productImage.findMany({
      where: inArray(productImage.productId, ids),
      columns: { id: true, productId: true },
    });

    const cascadedExternalIds = await tx.query.productExternalId.findMany({
      where: inArray(productExternalId.productId, ids),
      columns: { id: true, productId: true },
    });

    // Group cascaded items by product ID for audit logging
    const mappingsByProduct = new Map<string, number>();
    const imagesByProduct = new Map<string, number>();
    const externalIdsByProduct = new Map<string, number>();

    for (const mapping of cascadedMappings) {
      mappingsByProduct.set(
        mapping.productId,
        (mappingsByProduct.get(mapping.productId) ?? 0) + 1,
      );
    }

    for (const img of cascadedImages) {
      imagesByProduct.set(
        img.productId,
        (imagesByProduct.get(img.productId) ?? 0) + 1,
      );
    }

    for (const eid of cascadedExternalIds) {
      externalIdsByProduct.set(
        eid.productId,
        (externalIdsByProduct.get(eid.productId) ?? 0) + 1,
      );
    }

    // Soft delete unit mappings
    await tx
      .update(productUnitMappings)
      .set({ deletedAt: now })
      .where(inArray(productUnitMappings.productId, ids));

    // Soft delete external IDs
    await tx
      .update(productExternalId)
      .set({ deletedAt: now })
      .where(inArray(productExternalId.productId, ids));

    // Soft delete product images
    await tx
      .update(productImage)
      .set({ deletedAt: now })
      .where(inArray(productImage.productId, ids));

    // Soft delete products
    await tx
      .update(product)
      .set({ deletedAt: now })
      .where(inArray(product.id, ids));

    // Log audit entries with cascaded item counts (batch operation)
    const auditEntries = ids.map((id) => {
      const mappingCount = mappingsByProduct.get(id) ?? 0;
      const imageCount = imagesByProduct.get(id) ?? 0;

      const externalIdCount = externalIdsByProduct.get(id) ?? 0;

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (mappingCount > 0) {
        changes.cascadedUnitMappings = { from: mappingCount, to: 0 };
      }
      if (imageCount > 0) {
        changes.cascadedImages = { from: imageCount, to: 0 };
      }
      if (externalIdCount > 0) {
        changes.cascadedExternalIds = { from: externalIdCount, to: 0 };
      }

      return {
        entityType: "product" as const,
        entityId: id,
        action: "delete" as const,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      };
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};
