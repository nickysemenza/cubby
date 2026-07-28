/**
 * Product CRUD operations.
 * Core create, read, update, list operations for products.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  ProductFilters,
  ProductPickerItemOut,
} from "@cubby/schemas/product";
import {
  hasFoodIndicators,
  type ProductCategory,
  type ProductCreateInput,
  type ProductTopLevelOut,
  type ProductUpdateInput,
  productSortableFields,
} from "@cubby/schemas/product";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { countBy, uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import {
  image,
  inventoryEntry,
  location,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
  purchase,
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
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  idSetPresence,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  presenceCondition,
  relations,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";
import { generateUniqueProductShortcode } from "~/server/repo/shortcode-utils";

import {
  dbProductToAPI,
  dbProductToListAPI,
  dbProductToPickerItemAPI,
  dbProductToTopLevelAPI,
} from "./mappers";
import type { ProductDeepDB, ProductListDB } from "./types";
import {
  assertNoCanonicalPriceMapping,
  syncProductExternalIds,
  syncProductImages,
  syncProductUnitMappings,
} from "./update-helpers";

// Special-case sorts the generic column path can't produce (correlated
// subqueries / CASE). Clauses only DEFINE the field's order — the old
// trailing `"product"."name" asc` moved to the single tieBreaker below so a
// stacked secondary sort isn't swallowed mid-stack.
const resolveProductSort = (sort: SortParams) => {
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";

  if (sort.orderBy === "location") {
    return [
      sql.raw(
        `(SELECT min(l."name") FROM "InventoryEntry" ie ` +
          `JOIN "Location" l ON l."id" = ie."locationId" AND l."deletedAt" IS NULL ` +
          `WHERE ie."productId" = "product"."id" AND ie."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "unitMappingQuality") {
    return [
      sql.raw(
        `(CASE ` +
          `WHEN (SELECT count(*) FROM "ProductUnitMappings" pum WHERE pum."productId" = "product"."id" AND pum."deletedAt" IS NULL) >= 3 THEN 3 ` +
          `WHEN (SELECT count(*) FROM "ProductUnitMappings" pum WHERE pum."productId" = "product"."id" AND pum."deletedAt" IS NULL) >= 2 THEN 2 ` +
          `WHEN (SELECT count(*) FROM "ProductUnitMappings" pum WHERE pum."productId" = "product"."id" AND pum."deletedAt" IS NULL) >= 1 ` +
          `OR "product"."price" IS NOT NULL OR "product"."fdc_id" IS NOT NULL OR "product"."upc" IS NOT NULL THEN 1 ` +
          `ELSE 0 END) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "ingredient") {
    return [
      sql.raw(
        `(SELECT i."name" FROM "Ingredient" i WHERE i."id" = "product"."ingredientId") ${dirSql}`,
      ),
    ];
  }

  return null;
};

const productListOrderBy = (sorts: SortParams[], groupBy?: string) =>
  buildOrderBy(product, sorts, [...productSortableFields], {
    groupBy,
    resolve: resolveProductSort,
    tieBreaker: asc(product.name),
  });

const fetchProductById = async (
  db: Database,
  id: ProductId,
): Promise<ProductDeepDB | undefined> => {
  const row = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, id), notDeleted(product)),
    ...relations.product.full,
  });
  return row;
};

// Read path through the shared reader (fetch-with-relations → 404 → map). The
// write path stays hand-rolled below: product create/update/delete carry
// shortcode, image, unit-mapping, and valuation side-effects.
const productReader = createEntityReader({
  entityName: "product",
  fetchById: fetchProductById,
  fromDB: (_db, row: ProductDeepDB) => dbProductToAPI(row),
  notFoundReason: "PRODUCT_NOT_FOUND",
});

export const getProductByID = (db: Database, id: ProductId) =>
  productReader.getByID(db, id);

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
  const uniqueIds = uniq(ids);
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
    )
    // Display order: sortOrder first (0-default legacy rows tie-break on
    // createdAt) — images[0] is the cover everywhere.
    .orderBy(asc(productImage.sortOrder), asc(productImage.createdAt));

  for (const row of rows) {
    result[row.productId]?.push(row.image);
  }

  return result;
};

export const getProductUnitMappingsByProductIds = async (
  db: Database,
  ids: ProductId[],
): Promise<Record<string, UnitMapping[]>> => {
  const uniqueIds = uniq(ids);
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
  filters: ProductFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
) => {
  const dbClient = getDb(db);

  // Every cross-entity filter below is an UNCORRELATED subquery (it references
  // only the child table, never back at product.id), applied with
  // inArray/notInArray. That shape is load-bearing, not stylistic: THREE query
  // builders share `whereClause` — the data query runs through Drizzle's
  // relational query builder (which aliases the root table to "product"), the
  // count runs a plain unaliased `$count`, and the price-sum runs a plain
  // unaliased `.select().from(product)`. A correlated EXISTS referencing
  // `product.id` from inside a subquery resolves against different table names
  // in each context (and breaks the RQB data query, which only sees the
  // "product" alias). inArray/notInArray sidestep it because `product.id` is
  // referenced at the WHERE's top level, where all three rewrite it correctly.
  //
  // Every subquery is notDeleted-guarded at each join level. `pnpm check`'s
  // soft-delete guard only scans exists()/notExists() bodies, so it cannot see
  // these — the repo integration tests are the guard here.
  // Inner-joins Location so this matches what `dbProductToListAPI` renders — it
  // drops entries whose location is soft-deleted (`isNotDeleted(entry.location)`).
  // The exact mirror of locationList's product join.
  //
  // DEFENSIVE, not a live bug: no write path can currently produce a live entry
  // under a soft-deleted location. `deleteLocations` guards
  // LOCATION_HAS_INVENTORY symmetrically with `deleteProducts`'
  // PRODUCT_HAS_INVENTORY, and every inventory write rejects a soft-deleted
  // parent (inventory-softdelete-guard.integration.test.ts). This is
  // invariant-drift insurance: if a future bulk path ever breaks that pairing,
  // the filter and the rendered cell stay in agreement instead of silently
  // disagreeing — the failure mode of #428.
  const productIdsWithLiveInventory = dbClient
    .select({ productId: inventoryEntry.productId })
    .from(inventoryEntry)
    .innerJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(notDeleted(inventoryEntry));

  // `purchase.productId` is NULLABLE, so `isNotNull` is load-bearing: a NULL
  // inside a NOT IN list makes the whole predicate UNKNOWN and `notInArray`
  // would match zero rows instead of "products with no purchases".
  const productIdsWithPurchases = dbClient
    .select({ productId: purchase.productId })
    .from(purchase)
    .where(and(notDeleted(purchase), isNotNull(purchase.productId)));

  // Joins Image so this matches what the thumbnail cell actually renders — it
  // drops PDF manuals, and Image is separately soft-deletable from ProductImage.
  const productIdsWithImages = dbClient
    .select({ productId: productImage.productId })
    .from(productImage)
    .innerJoin(
      image,
      and(eq(image.id, productImage.imageId), notDeleted(image)),
    )
    .where(
      and(notDeleted(productImage), ne(image.contentType, PDF_CONTENT_TYPE)),
    );

  const productIdsWithUnitMappings = dbClient
    .select({ productId: productUnitMappings.productId })
    .from(productUnitMappings)
    .where(notDeleted(productUnitMappings));

  // Mirrors `foodLookupParamFromProduct` returning null: no explicit fdc_id AND
  // no upc to auto-match. This is the closest pure-SQL predicate — it cannot
  // know whether the USDA worker resolves a food for that key, which is why the
  // filter is labelled "USDA key". Passed as `presenceCondition`'s `emptyWhen`
  // so "has" is derived as not(this) and the two branches can't drift.
  // The outer parens are load-bearing, same as TAGS_ARE_EMPTY in recipe/crud.ts:
  // `presenceCondition` derives "has" as `not(this)`, and drizzle's `not()`
  // doesn't add its own. Unparenthesized, `NOT a IS NULL AND b IS NULL` binds as
  // `(NOT a IS NULL) AND (b IS NULL)` — i.e. "has fdc_id AND has no upc", which
  // silently drops every UPC-only product from "has".
  const NO_USDA_KEY = sql`(${product.fdc_id} IS NULL AND ${product.upc} IS NULL)`;

  // Build where conditions - always filter out deleted items
  const whereClause = buildSearchConditions(
    product,
    [
      { column: product.name, term: filters.nameFilter },
      { column: product.manufacturer, term: filters.manufacturerFilter },
      { column: product.upc, term: filters.upcFilter },
    ],
    [
      eqAnyOrPresence(
        product.category,
        filters.categoryFilter,
        filters.categoryPresenceFilter,
      ),
      filters.ingredientPresenceFilter === "none"
        ? isNull(product.ingredientId)
        : undefined,
      filters.ingredientPresenceFilter === "has"
        ? isNotNull(product.ingredientId)
        : undefined,
      idSetPresence(
        product.id,
        filters.inventoryPresenceFilter,
        productIdsWithLiveInventory,
      ),
      idSetPresence(
        product.id,
        filters.purchasePresenceFilter,
        productIdsWithPurchases,
      ),
      idSetPresence(
        product.id,
        filters.imagePresenceFilter,
        productIdsWithImages,
      ),
      idSetPresence(
        product.id,
        filters.unitMappingPresenceFilter,
        productIdsWithUnitMappings,
      ),
      presenceCondition(
        product.fdc_id,
        filters.usdaPresenceFilter,
        NO_USDA_KEY,
      ),
    ],
  );

  // Special list sort keys are correlated subqueries because Drizzle's
  // relational query builder rewrites non-raw column refs to the root alias.
  const orderByArray = productListOrderBy(sorts, groupBy);

  const { take, skip } = buildTakeSkip(pagination);

  // Execute queries in parallel and transform results. The aggregate query
  // shares whereClause, so the footer's price total covers the FULL filtered
  // set (the client only holds a page).
  const [{ data: results, count: totalCount }, aggregates] = await Promise.all([
    executeListQueryWithCount(
      getDb(db).query.product.findMany({
        where: whereClause,
        orderBy: orderByArray,
        limit: take,
        offset: skip,
        ...relations.product.list,
      }),
      countWhere(db, product, whereClause),
    ),
    getDb(db)
      .select({ priceSum: sum(product.price) })
      .from(product)
      .where(whereClause),
  ]);

  const products = results.map((prod: ProductListDB) =>
    dbProductToListAPI(prod),
  );

  const priceSum = Number(aggregates[0]?.priceSum ?? 0);

  return {
    data: products,
    count: totalCount,
    sums: { price: Number.isNaN(priceSum) ? 0 : priceSum },
  };
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
  // Narrowed on purpose: this path ignores the presence filters, and the type
  // should say so rather than accept the full ProductFilters and drop them.
  filters: Pick<
    ProductFilters,
    "nameFilter" | "manufacturerFilter" | "upcFilter" | "categoryFilter"
  >,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: ProductPickerItemOut[]; count: number }> => {
  const name = filters.nameFilter;
  const whereClause = and(
    notDeleted(product),
    name !== undefined && name.trim() !== ""
      ? or(
          formatSearchTerm(product.name, name),
          sql`EXISTS (SELECT 1 FROM unnest(${product.aliases}) AS alias WHERE alias ILIKE ${`%${name}%`})`,
        )
      : undefined,
    formatSearchTerm(product.manufacturer, filters.manufacturerFilter),
    formatSearchTerm(product.upc, filters.upcFilter),
    eqAny(product.category, filters.categoryFilter),
  );

  // Same ordering rules as productList, so picker results match the table's sort
  // for any shared query params.
  const orderByArray = productListOrderBy(sorts);

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

export const getProductPickerItemsByIds = async (
  db: Database,
  ids: ProductId[],
): Promise<ProductPickerItemOut[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.product.findMany({
    where: and(sql`${product.id} = ANY(${ids})`, notDeleted(product)),
    columns: {
      id: true,
      shortcode: true,
      name: true,
      manufacturer: true,
    },
  });
  const byId = new Map(
    rows.map((row) => [row.id, dbProductToPickerItemAPI(row)]),
  );
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
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
    imageOrder,
    ...productData
  } = data;

  // Use a transaction to ensure atomicity
  return await withTransaction(db, async (tx) => {
    // Fetch current state for audit logging
    const beforeProduct = await tx.query.product.findFirst({
      where: and(eq(product.id, id), notDeleted(product)),
    });

    if (!beforeProduct) {
      throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
    }

    // A canonical "1 each = $X" mapping duplicates the price column; reject it.
    if (unitMappings !== undefined) assertNoCanonicalPriceMapping(unitMappings);

    // Build update data (price flows in via ...productData)
    const updateData: {
      name?: string;
      aliases?: string[];
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
    const updated = await updateLiveAndReturn(tx, product, updateData, id);

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
    await syncProductImages(
      tx,
      id,
      pendingImageIds,
      removeImageIds,
      imageOrder,
    );

    // Fetch all associated images (live only — just-removed ones must not
    // reappear in the response) in display order.
    const productImages = await tx.query.productImage.findMany({
      where: and(
        eq(productImage.productId, updated.id),
        notDeleted(productImage),
      ),
      with: {
        image: true,
      },
      orderBy: [asc(productImage.sortOrder), asc(productImage.createdAt)],
    });

    // Log audit entry with changes
    const changes = computeChanges(beforeProduct, updated, [
      "name",
      "aliases",
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
      where: and(
        inArray(productUnitMappings.productId, ids),
        notDeleted(productUnitMappings),
      ),
      columns: { productId: true },
    });

    const cascadedImages = await tx.query.productImage.findMany({
      where: and(
        inArray(productImage.productId, ids),
        notDeleted(productImage),
      ),
      columns: { productId: true },
    });

    const cascadedExternalIds = await tx.query.productExternalId.findMany({
      where: and(
        inArray(productExternalId.productId, ids),
        notDeleted(productExternalId),
      ),
      columns: { productId: true },
    });

    // Soft delete unit mappings
    await tx
      .update(productUnitMappings)
      .set({ deletedAt: now })
      .where(
        and(
          inArray(productUnitMappings.productId, ids),
          notDeleted(productUnitMappings),
        ),
      );

    // Soft delete external IDs
    await tx
      .update(productExternalId)
      .set({ deletedAt: now })
      .where(
        and(
          inArray(productExternalId.productId, ids),
          notDeleted(productExternalId),
        ),
      );

    // Soft delete product images
    await tx
      .update(productImage)
      .set({ deletedAt: now })
      .where(
        and(inArray(productImage.productId, ids), notDeleted(productImage)),
      );

    // Soft delete products
    await tx
      .update(product)
      .set({ deletedAt: now })
      .where(and(inArray(product.id, ids), notDeleted(product)));

    // Cascade the search embedding so a direct repo delete (no mutation
    // side-effect) can't leave an orphaned entityEmbedding row.
    await softDeleteEntityEmbeddingsTx(tx, "product", ids);

    const auditEntries = buildCascadeAuditEntries("product", ids, {
      cascadedUnitMappings: countBy(cascadedMappings, (m) => m.productId),
      cascadedImages: countBy(cascadedImages, (i) => i.productId),
      cascadedExternalIds: countBy(cascadedExternalIds, (e) => e.productId),
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};
