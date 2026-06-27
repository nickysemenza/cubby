/**
 * Product CRUD operations.
 * Core create, read, update, list operations for products.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image-responses";
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
  type ProductUpdateInput,
} from "@cubby/schemas/product";
import type { ProductPickerItemOut } from "@cubby/schemas/product-responses";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { countBy } from "es-toolkit";
import { getSortableFields } from "~/entities/entities";
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
  buildCascadeAuditEntries,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  assertNoDependents,
  associatePendingImages,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
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

import {
  dbProductToAPI,
  dbProductToListAPI,
  dbProductToPickerItemAPI,
  dbProductToTopLevelAPI,
} from "./mappers";
import type { ProductListDB } from "./types";
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

export const getProductsForFoodLookup = async (
  db: Database,
  ids: ProductId[],
) => {
  if (ids.length === 0) return [];
  return await getDb(db).query.product.findMany({
    where: and(inArray(product.id, ids), notDeleted(product)),
    columns: {
      id: true,
      upc: true,
      fdc_id: true,
    },
  });
};

export const getProductImagesByProductIds = async (
  db: Database,
  ids: ProductId[],
): Promise<Record<string, ImageOut[]>> => {
  const uniqueIds = [...new Set(ids)];
  const result: Record<string, ImageOut[]> = Object.fromEntries(
    uniqueIds.map((id) => [id, []]),
  );
  if (uniqueIds.length === 0) return result;

  const rows = await getDb(db)
    .select({
      productId: productImage.productId,
      image,
    })
    .from(productImage)
    .innerJoin(image, eq(productImage.imageId, image.id))
    .where(
      and(
        inArray(productImage.productId, uniqueIds),
        notDeleted(productImage),
        notDeleted(image),
      ),
    );

  for (const row of rows) {
    result[row.productId]?.push(row.image);
  }

  return result;
};

export const getProductUnitMappingsByProductIds = async (
  db: Database,
  ids: ProductId[],
): Promise<Record<string, UnitMapping[]>> => {
  const uniqueIds = [...new Set(ids)];
  const result: Record<string, UnitMapping[]> = Object.fromEntries(
    uniqueIds.map((id) => [id, []]),
  );
  if (uniqueIds.length === 0) return result;

  const rows = await getDb(db).query.productUnitMappings.findMany({
    where: and(
      inArray(productUnitMappings.productId, uniqueIds),
      notDeleted(productUnitMappings),
    ),
  });

  for (const row of rows) {
    result[row.productId]?.push({
      a: row.a,
      b: row.b,
      source: row.source,
      sourceMetadata: { type: "product", productId: row.productId },
    });
  }

  return result;
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
      ...relations.product.list,
    }),
    countWhere(db, product, whereClause),
  );

  const products = results.map((prod: ProductListDB) =>
    dbProductToListAPI(prod),
  );

  return { data: products, count: totalCount };
};

/**
 * Lightweight product search for typeahead/picker comboboxes.
 *
 * Returns the product picker shape only — it deliberately skips the inventory /
 * ingredient / unit-mapping / image / external-id relation joins that
 * `productList` pulls. Pickers only need `{id, name, manufacturer, shortcode}`,
 * so this endpoint should not pretend to carry full product rows.
 */
export const productSearch = async (
  db: Database,
  name: string | undefined,
  manufacturer: string | undefined,
  upc: string | undefined,
  category: ProductCategory | undefined,
  sort: SortParams,
  pagination: PaginationParams,
): Promise<{ data: ProductPickerItemOut[]; count: number }> => {
  const whereClause = buildSearchConditions(
    product,
    [
      { column: product.name, term: name },
      { column: product.manufacturer, term: manufacturer },
      { column: product.upc, term: upc },
    ],
    [category !== undefined ? eq(product.category, category) : undefined],
  );

  // Same ordering rules as productList (incl. the linked-ingredient subquery),
  // so picker results match the table's sort. The raw subquery references the
  // "product" root alias, which holds with no relations selected.
  const orderByArray =
    sort.orderBy === "ingredient"
      ? [
          sql.raw(
            `(SELECT i."name" FROM "Ingredient" i WHERE i."id" = "product"."ingredientId") ${
              sort.direction === "asc" ? "asc nulls last" : "desc nulls last"
            }`,
          ),
        ]
      : buildOrderBy(product, sort, [...getSortableFields("product")]);

  const { take, skip } = buildTakeSkip(pagination);

  const { data: results, count } = await executeListQueryWithCount(
    // No `...relations.product.full` — scalar columns only. The picker output
    // schema omits relations that were not loaded.
    getDb(db).query.product.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
    }),
    countWhere(db, product, whereClause),
  );

  const data = results.map(dbProductToPickerItemAPI);

  return { data, count };
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

      return dbProductToTopLevelAPI({
        ...newProduct,
        images,
        externalIds: createdExternalIds,
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
  data: ProductUpdateInput["data"],
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

    return dbProductToTopLevelAPI({
      ...updated,
      images: productImages,
      externalIds: currentExternalIds,
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

  return dbProductToTopLevelAPI({
    ...newProduct,
    images: [],
    externalIds: [],
  });
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
    await assertNoDependents({
      offendingParentIds: withInventory.map((e) => e.productId),
      fetchNames: (failedIds) =>
        tx.query.product.findMany({
          where: inArray(product.id, failedIds),
          columns: { name: true },
        }),
      reason: "PRODUCT_HAS_INVENTORY",
      message: (count, names) =>
        `Cannot delete ${count} product(s): ${names} have inventory entries. Remove inventory items first.`,
    });

    const now = new Date();

    // Get counts of cascaded items (per product) for the audit trail.
    const cascadedMappings = await tx.query.productUnitMappings.findMany({
      where: inArray(productUnitMappings.productId, ids),
      columns: { productId: true },
    });

    const cascadedImages = await tx.query.productImage.findMany({
      where: inArray(productImage.productId, ids),
      columns: { productId: true },
    });

    const cascadedExternalIds = await tx.query.productExternalId.findMany({
      where: inArray(productExternalId.productId, ids),
      columns: { productId: true },
    });

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

    const auditEntries = buildCascadeAuditEntries("product", ids, {
      cascadedUnitMappings: countBy(cascadedMappings, (m) => m.productId),
      cascadedImages: countBy(cascadedImages, (i) => i.productId),
      cascadedExternalIds: countBy(cascadedExternalIds, (e) => e.productId),
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};
