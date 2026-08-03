/**
 * Product CRUD operations.
 * Core create, read, update, list operations for products.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { ImpactItem } from "@cubby/schemas/entity-integrity";
import {
  type ExternalIdKind,
  storedExternalIdUrl,
} from "@cubby/schemas/external-id";
import type {
  IngredientId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
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
  arrayOverlaps,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  sum,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { countBy, uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  image,
  inventoryEntry,
  location,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
  projectToolUsage,
  purchase,
  task,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  buildCascadeAuditEntries,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  loadProductDataQualities,
  productAnyDataGapCondition,
  productDataGapCondition,
  productDefectCondition,
  productNeedsDataCondition,
} from "~/server/repo/data-quality";
import {
  assertNoDependents,
  associatePendingImages,
  auditDateWhereConditions,
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
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  PRODUCT_DELETE_EDGE_POLICY,
  type ProductRetainingEdgeKey,
} from "./edge-roles";
import {
  dbProductToAPI,
  dbProductToListAPI,
  dbProductToPickerItemAPI,
  dbProductToTopLevelAPI,
} from "./mappers";
import {
  effectiveProductPriceSql,
  enrichProductRowsWithPricing,
  loadProductPricing,
  resolveProductPricing,
} from "./pricing";
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

  if (sort.orderBy === "ingredient") {
    return [
      sql.raw(
        `(SELECT i."name" FROM "Ingredient" i WHERE i."id" = "product"."ingredientId") ${dirSql}`,
      ),
    ];
  }

  // Same correlated-scalar shape as `relations.product.list.extras.expenseTotal`
  // — the RQB data query's root alias for product is lowercase "product".
  if (sort.orderBy === "expenseTotal") {
    return [
      sql.raw(
        `(SELECT COALESCE(sum(e."cost"), 0)::double precision FROM "Expense" e ` +
          `WHERE e."productId" = "product"."id" AND e."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "price") {
    return [sql.raw(`${effectiveProductPriceSql()} ${dirSql}`)];
  }

  if (sort.orderBy === "expenses") {
    return [
      sql.raw(
        `(SELECT count(*) FROM "Expense" e ` +
          `WHERE e."productId" = "product"."id" AND e."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "purchaseDate") {
    return [
      sql.raw(
        `(SELECT max(p."date") FROM "Expense" e ` +
          `JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL ` +
          `WHERE e."productId" = "product"."id" AND e."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "related:product.purchases") {
    return [
      sql.raw(
        `(SELECT max(COALESCE(p."date"::timestamp, p."createdAt")) FROM "Expense" e ` +
          `JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL ` +
          `WHERE e."productId" = "product"."id" AND e."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "related:product.projects") {
    return [
      sql.raw(
        `(SELECT min(lower(pr."name")) FROM "Expense" e ` +
          `JOIN "Project" pr ON pr."id" = e."projectId" AND pr."deletedAt" IS NULL ` +
          `WHERE e."productId" = "product"."id" AND e."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "related:product.vendors") {
    return [
      sql.raw(
        `(SELECT min(lower(v."name")) FROM "Expense" e ` +
          `JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL ` +
          `JOIN "Vendor" v ON v."id" = p."vendorId" AND v."deletedAt" IS NULL ` +
          `WHERE e."productId" = "product"."id" AND e."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "identity_strength") {
    return [
      sql.raw(`CASE
        WHEN "product"."upc" IS NOT NULL AND "product"."upc" <> '' THEN 0
        WHEN EXISTS (SELECT 1 FROM "ProductExternalId" pei WHERE pei."productId" = "product"."id" AND pei."deletedAt" IS NULL) THEN 1
        WHEN lower(trim("product"."manufacturer")) NOT IN ('', 'generic', '(unspecified)') AND coalesce(trim("product"."model"), '') <> '' THEN 2
        WHEN coalesce(trim("product"."model"), '') <> '' THEN 3
        ELSE 4 END ${dirSql}`),
    ];
  }

  return null;
};

const productListOrderBy = (sorts: SortParams[], groupBy?: string) =>
  buildOrderBy(product, sorts, [...productSortableFields], {
    groupBy,
    resolve: resolveProductSort,
    tieBreaker: sql`${product.name} ASC, ${product.shortcode} ASC`,
  });

const fetchProductById = async (
  db: Database,
  id: ProductId,
): Promise<ProductDeepDB | undefined> => {
  const row = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, id), notDeleted(product)),
    ...relations.product.full,
  });
  if (!row) return undefined;
  return (await enrichProductRowsWithPricing(db, [row]))[0];
};

// Read path through the shared reader (fetch-with-relations → 404 → map). The
// write path stays hand-rolled below: product create/update/delete carry
// shortcode, image, unit-mapping, and valuation side-effects.
const productReader = createEntityReader({
  entity: "product",
  fetchById: fetchProductById,
  fromDB: async (db, row: ProductDeepDB) => {
    const qualities = await loadProductDataQualities(db, [row.id]);
    return dbProductToAPI(row, qualities.get(row.id)!);
  },
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
) => {
  const uniqueIds = uniq(ids);
  const result: Record<
    string,
    Array<
      Omit<UnitMapping, "sourceMetadata"> & {
        sourceMetadata: { type: "product"; productId: ProductId };
      }
    >
  > = Object.fromEntries(uniqueIds.map((id) => [id, []]));
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
 * Fetch multiple products by shortcodes in a single query.
 * Returns basic product data (suitable for labels).
 */
/** Public-id read: `null` for an unknown code or a soft-deleted row. */
export const getProductByShortcode = (db: Database, shortcode: string) =>
  productReader.getByShortcode(db, shortcode);

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
  const qualities = await loadProductDataQualities(
    db,
    results.map((row) => row.id),
  );
  const priced = await enrichProductRowsWithPricing(db, results);
  return priced.map((row) => dbProductToAPI(row, qualities.get(row.id)!));
};

export const productList = async (
  db: Database,
  filters: ProductFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
) => {
  const dbClient = getDb(db);

  const requestedLocationCodes = filters.locationIdFilter
    ? [filters.locationIdFilter].flat()
    : [];
  const requestedIngredientCodes = filters.ingredientIdFilter
    ? [filters.ingredientIdFilter].flat()
    : [];
  const [locationIdMap, ingredientIdMap] = await Promise.all([
    resolveLiveShortcodes(db, requestedLocationCodes, "location"),
    resolveLiveShortcodes(db, requestedIngredientCodes, "ingredient"),
  ]);
  const selectedLocationIds = [...locationIdMap.values()] as LocationId[];
  const selectedIngredientIds = [...ingredientIdMap.values()] as IngredientId[];

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

  const productIdsAtSelectedLocations = dbClient
    .select({ productId: inventoryEntry.productId })
    .from(inventoryEntry)
    .innerJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(
      and(
        notDeleted(inventoryEntry),
        selectedLocationIds.length > 0
          ? inArray(inventoryEntry.locationId, selectedLocationIds)
          : sql`false`,
      ),
    );

  // `expense.productId` is NULLABLE, so `isNotNull` is load-bearing: a NULL
  // inside a NOT IN list makes the whole predicate UNKNOWN and `notInArray`
  // would match zero rows instead of "products with no expenses".
  const productIdsWithExpenses = dbClient
    .select({ productId: expense.productId })
    .from(expense)
    .where(and(notDeleted(expense), isNotNull(expense.productId)));

  // Effective price exists when either Product carries an explicit override or
  // at least one actual, positive Expense has a known product quantity. Keep
  // this uncorrelated for the shared RQB/count/aggregate where clause below.
  const productIdsWithDerivedPrice = dbClient
    .select({ productId: expense.productId })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        gt(expense.cost, 0),
        isNotNull(expense.productId),
        isNotNull(expense.productQuantity),
      ),
    )
    .groupBy(expense.productId);

  const productIdsWithPurchases = dbClient
    .select({ productId: expense.productId })
    .from(expense)
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .where(and(notDeleted(expense), isNotNull(expense.productId)));

  const taskStatuses = filters.taskStatusFilter
    ? [filters.taskStatusFilter].flat()
    : undefined;
  const taskFilterActive = Boolean(
    taskStatuses?.length ||
      filters.taskOpenOnly ||
      filters.taskDueFrom ||
      filters.taskDueTo,
  );
  const productIdsWithFilteredTasks = dbClient
    .select({ productId: task.subjectProductId })
    .from(task)
    .where(
      and(
        notDeleted(task),
        isNotNull(task.subjectProductId),
        taskStatuses?.length ? inArray(task.status, taskStatuses) : undefined,
        filters.taskOpenOnly ? ne(task.status, "done") : undefined,
        filters.taskDueFrom
          ? sql`${task.dueDate} >= ${filters.taskDueFrom}`
          : undefined,
        filters.taskDueTo
          ? sql`${task.dueDate} <= ${filters.taskDueTo}`
          : undefined,
      ),
    );

  const purchaseDateRangeActive = Boolean(
    filters.purchaseDateFrom || filters.purchaseDateTo,
  );
  const productIdsInPurchaseDateRange = dbClient
    .select({ productId: expense.productId })
    .from(expense)
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .where(
      and(
        notDeleted(expense),
        isNotNull(expense.productId),
        filters.purchaseDateFrom
          ? sql`${purchase.date} >= ${filters.purchaseDateFrom}`
          : undefined,
        filters.purchaseDateTo
          ? sql`${purchase.date} <= ${filters.purchaseDateTo}`
          : undefined,
      ),
    );

  // Joins Image so this matches what the thumbnail cell actually renders — it
  // drops PDF manuals, and Image is separately soft-deletable from ProductImage.
  const productIdsWithImages = dbClient
    .select({ productId: productImage.productId })
    .from(productImage)
    .innerJoin(
      image,
      and(eq(image.id, productImage.imageId), notDeleted(image)),
    )
    .where(and(notDeleted(productImage), displayableImageWhere));

  const productIdsWithUnitMappings = dbClient
    .select({ productId: productUnitMappings.productId })
    .from(productUnitMappings)
    .where(notDeleted(productUnitMappings));

  const externalSources = filters.externalIdSource
    ? [filters.externalIdSource].flat()
    : undefined;
  const productIdsWithExternalIds = dbClient
    .select({ productId: productExternalId.productId })
    .from(productExternalId)
    .where(
      and(
        notDeleted(productExternalId),
        externalSources && externalSources.length > 0
          ? inArray(productExternalId.source, externalSources)
          : undefined,
      ),
    );

  const selectedDataGaps = filters.dataGap ? [filters.dataGap].flat() : [];
  const needsData = productNeedsDataCondition();

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

  // Untagged. Outer parens load-bearing for the same `not()` reason as above.
  const NO_TAGS = sql`(cardinality(${product.tags}) = 0)`;

  // Build where conditions - always filter out deleted items
  const whereClause = buildSearchConditions(
    product,
    [
      { column: product.name, term: filters.nameFilter },
      { column: product.manufacturer, term: filters.manufacturerFilter },
      { column: product.upc, term: filters.upcFilter },
      { column: product.model, term: filters.modelFilter },
      { column: product.notes, term: filters.notesFilter },
    ],
    [
      ...auditDateWhereConditions(product, filters),
      ...relatedWhereConditions("product", filters, product.id),
      eqAnyOrPresence(
        product.category,
        filters.categoryFilter,
        filters.categoryPresenceFilter,
      ),
      requestedIngredientCodes.length > 0 && selectedIngredientIds.length === 0
        ? sql`false`
        : or(
            selectedIngredientIds.length > 0
              ? inArray(product.ingredientId, selectedIngredientIds)
              : undefined,
            presenceCondition(
              product.ingredientId,
              filters.ingredientPresenceFilter,
            ),
          ),
      requestedLocationCodes.length > 0 && selectedLocationIds.length === 0
        ? sql`false`
        : or(
            selectedLocationIds.length > 0
              ? inArray(product.id, productIdsAtSelectedLocations)
              : undefined,
            idSetPresence(
              product.id,
              filters.inventoryPresenceFilter,
              productIdsWithLiveInventory,
            ),
          ),
      filters.expenseCountMin !== undefined
        ? sql`(SELECT count(*) FROM "Expense" e WHERE e."productId" = ${product.id} AND e."deletedAt" IS NULL) >= ${filters.expenseCountMin}`
        : undefined,
      filters.expenseCountMax !== undefined
        ? sql`(SELECT count(*) FROM "Expense" e WHERE e."productId" = ${product.id} AND e."deletedAt" IS NULL) <= ${filters.expenseCountMax}`
        : undefined,
      filters.expenseTotalMin !== undefined
        ? sql`(SELECT COALESCE(sum(e."cost"), 0) FROM "Expense" e WHERE e."productId" = ${product.id} AND e."deletedAt" IS NULL) >= ${filters.expenseTotalMin}`
        : undefined,
      filters.expenseTotalMax !== undefined
        ? sql`(SELECT COALESCE(sum(e."cost"), 0) FROM "Expense" e WHERE e."productId" = ${product.id} AND e."deletedAt" IS NULL) <= ${filters.expenseTotalMax}`
        : undefined,
      idSetPresence(
        product.id,
        filters.expensePresenceFilter,
        productIdsWithExpenses,
      ),
      idSetPresence(
        product.id,
        filters.purchaseDatePresenceFilter,
        productIdsWithPurchases,
      ),
      taskFilterActive
        ? inArray(product.id, productIdsWithFilteredTasks)
        : undefined,
      purchaseDateRangeActive
        ? inArray(product.id, productIdsInPurchaseDateRange)
        : undefined,
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
      idSetPresence(
        product.id,
        filters.externalIdPresenceFilter ??
          (externalSources && externalSources.length > 0 ? "has" : undefined),
        productIdsWithExternalIds,
      ),
      presenceCondition(product.model, filters.modelPresenceFilter),
      presenceCondition(product.upc, filters.upcPresenceFilter),
      presenceCondition(product.notes, filters.notesPresenceFilter),
      filters.manufacturerExact
        ? inArray(product.manufacturer, [filters.manufacturerExact].flat())
        : undefined,
      filters.dataStatus === "needs_data"
        ? needsData
        : filters.dataStatus === "defect"
          ? productDefectCondition()
          : filters.dataStatus === "complete"
            ? sql`NOT ${productAnyDataGapCondition()}`
            : undefined,
      selectedDataGaps.length > 0
        ? or(...selectedDataGaps.map(productDataGapCondition))
        : undefined,
      presenceCondition(
        product.fdc_id,
        filters.usdaPresenceFilter,
        NO_USDA_KEY,
      ),
      filters.pricePresenceFilter === "none"
        ? and(
            isNull(product.price),
            notInArray(product.id, productIdsWithDerivedPrice),
          )
        : filters.pricePresenceFilter === "has"
          ? or(
              isNotNull(product.price),
              inArray(product.id, productIdsWithDerivedPrice),
            )
          : undefined,
      // OR-ed with the tag column's presence sentinel so "M18 or untagged" is
      // one filter, same shape as recipe/crud.ts. `product.tags` is notNull
      // with a `'{}'` default, so untagged is only ever zero-length — no
      // `IS NULL` half to check, unlike `recipe.tags`.
      // `arrayOverlaps`, NOT sql`${col} && ${arr}`: interpolating a JS array
      // emits a row constructor `($1,$2)` rather than `text[]`.
      or(
        filters.tagFilters && filters.tagFilters.length > 0
          ? arrayOverlaps(product.tags, filters.tagFilters)
          : undefined,
        presenceCondition(product.tags, filters.tagsPresenceFilter, NO_TAGS),
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
  const [{ data: results, count: totalCount }, aggregates, expenseAggregates] =
    await Promise.all([
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
        .select({
          priceSum: sql<number>`sum(${sql.raw(
            effectiveProductPriceSql('"Product"'),
          )})`,
        })
        .from(product)
        .where(whereClause),
      // Net-basis total for the Net basis column's footer, over the FULL filtered
      // set — without it `createCurrencyColumn` falls back to reducing the loaded
      // rows only, which silently under-reports on an infinite-scrolled list.
      //
      // An uncorrelated `IN` sub-select over the same where clause, NOT a
      // correlated `sum((SELECT …))` in the select field: interpolating
      // `product.id` there hits the `buildSelection` prefix-stripping trap that
      // has cost this repo four bugs (see the warning block in repo/purchase.ts).
      // Summing `Expense` directly also reads plainly — this is money, and money
      // lives on `Expense`.
      getDb(db)
        .select({ expenseTotalSum: sum(expense.cost) })
        .from(expense)
        .where(
          and(
            notDeleted(expense),
            inArray(
              expense.productId,
              getDb(db)
                .select({ id: product.id })
                .from(product)
                .where(whereClause),
            ),
          ),
        ),
    ]);

  const qualities = await loadProductDataQualities(
    db,
    results.map((row) => row.id),
  );
  const pricedResults = await enrichProductRowsWithPricing(db, results);
  const products = pricedResults.map((prod: ProductListDB) =>
    dbProductToListAPI({
      ...prod,
      dataQuality: qualities.get(prod.id),
    }),
  );

  const priceSum = Number(aggregates[0]?.priceSum ?? 0);
  // `sum()` returns null over an empty set, and a string otherwise.
  const expenseTotalSum = Number(expenseAggregates[0]?.expenseTotalSum ?? 0);

  return {
    data: products,
    count: totalCount,
    sums: {
      price: Number.isNaN(priceSum) ? 0 : priceSum,
      expenseTotal: Number.isNaN(expenseTotalSum) ? 0 : expenseTotalSum,
    },
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
          formatSearchTerm(product.notes, name),
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
    // `inArray`, NOT sql`col = ANY(${arr})`: drizzle expands a JS array in a
    // template into a row constructor (`ANY(($1, $2))`), which postgres rejects.
    where: and(inArray(product.id, ids), notDeleted(product)),
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

const assertExternalIdsAvailable = async (
  tx: DrizzleTransaction,
  entries: readonly {
    source: string;
    kind: ExternalIdKind;
    externalId: string;
  }[],
  exceptProductId?: ProductId,
): Promise<void> => {
  if (entries.length === 0) return;
  const [owner] = await tx
    .select({
      productId: product.id,
      productShortcode: product.shortcode,
      productName: product.name,
      source: productExternalId.source,
      kind: productExternalId.kind,
      externalId: productExternalId.externalId,
    })
    .from(productExternalId)
    .innerJoin(
      product,
      and(eq(product.id, productExternalId.productId), notDeleted(product)),
    )
    .where(
      and(
        notDeleted(productExternalId),
        exceptProductId
          ? sql`${productExternalId.productId} <> ${exceptProductId}`
          : undefined,
        or(
          ...entries.map((entry) =>
            and(
              eq(productExternalId.source, entry.source),
              eq(productExternalId.kind, entry.kind),
              eq(productExternalId.externalId, entry.externalId),
            ),
          ),
        ),
      ),
    )
    .limit(1);
  if (!owner) return;
  throw createAppError(
    "PRODUCT_ALREADY_EXISTS",
    `${owner.source}/${owner.kind}/${owner.externalId} already belongs to ${owner.productShortcode} “${owner.productName}”.`,
  );
};

// Create a new product
export const createProduct = async (
  db: Database,
  data: ProductRepoCreateInput,
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
  // Per-each price is the scalar `productData.price` column; a canonical
  // "1 each = $X" mapping would duplicate it (per-measure money mappings are OK).
  if (unitMappings) assertNoCanonicalPriceMapping(unitMappings);

  // Use a transaction to ensure atomicity. On a unique violation (e.g. another
  // product already links this USDA food/UPC), translate the raw DB error into a
  // clear CONFLICT message — the lookups run on `db` because the tx is aborted.
  try {
    return await withTransaction(db, async (tx) => {
      await assertExternalIdsAvailable(tx, externalIds ?? []);
      // Create the product first (price flows in via ...productData)
      const newProduct = await insertWithShortcode(tx, "product", {
        ...productData,
        category,
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
            source: eid.source.trim().toLowerCase(),
            kind: eid.kind,
            externalId: eid.externalId,
            url: storedExternalIdUrl(eid),
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
        pricing: resolveProductPricing(newProduct.price),
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
  data: ProductRepoUpdateData,
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
      tags?: string[];
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
      await assertExternalIdsAvailable(tx, externalIds, id);
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
      "tags",
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

    const pricing = await loadProductPricing(tx, [updated]);
    return dbProductToTopLevelAPI({
      ...updated,
      pricing: pricing.get(updated.id) ?? resolveProductPricing(updated.price),
      images: productImages,
      externalIds: currentExternalIds,
    });
  });
};

/** Patch selected external-ID slots without replacing unrelated identifiers. */
export const patchProductExternalIds = async (
  db: Database,
  id: ProductId,
  input: {
    upsert: Array<{
      source: string;
      kind: ExternalIdKind;
      externalId: string;
      url?: string | null;
    }>;
    remove: Array<{
      source: string;
      kind: ExternalIdKind;
      expectedExternalId: string;
    }>;
  },
  actor: ActorContext,
): Promise<ProductTopLevelOut> =>
  await withTransaction(db, async (tx) => {
    // Serialize slot patches for one Product while allowing other Products to
    // proceed independently. The conflict target below still protects each
    // individual slot at the database boundary.
    await lockAndValidateForDelete(tx, product, [id], "Product");
    const before = await tx.query.product.findFirst({
      where: and(eq(product.id, id), notDeleted(product)),
    });
    if (!before)
      throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
    const beforeIds = await tx.query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, id),
        notDeleted(productExternalId),
      ),
    });

    for (const entry of input.remove) {
      const source = entry.source.trim().toLowerCase();
      const current = beforeIds.find(
        (externalId) =>
          externalId.source === source && externalId.kind === entry.kind,
      );
      if (!current || current.externalId !== entry.expectedExternalId) {
        throw createAppError(
          "PRODUCT_EXTERNAL_ID_PRECONDITION_FAILED",
          current
            ? `Product external ID ${source}/${entry.kind} is ${current.externalId}, not the expected ${entry.expectedExternalId}.`
            : `Product has no live external ID in slot ${source}/${entry.kind}.`,
        );
      }
    }

    await assertExternalIdsAvailable(tx, input.upsert, id);

    for (const entry of input.remove) {
      await tx
        .update(productExternalId)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(productExternalId.productId, id),
            eq(productExternalId.source, entry.source.trim().toLowerCase()),
            eq(productExternalId.kind, entry.kind),
            notDeleted(productExternalId),
          ),
        );
    }
    for (const entry of input.upsert) {
      const source = entry.source.trim().toLowerCase();
      await tx
        .insert(productExternalId)
        .values({
          productId: id,
          source,
          kind: entry.kind,
          externalId: entry.externalId,
          url: storedExternalIdUrl({ ...entry, source }),
        })
        .onConflictDoUpdate({
          target: [
            productExternalId.productId,
            productExternalId.source,
            productExternalId.kind,
          ],
          targetWhere: sql`${productExternalId.deletedAt} IS NULL`,
          set: {
            externalId: entry.externalId,
            url: storedExternalIdUrl({ ...entry, source }),
            updatedAt: new Date(),
          },
        });
    }
    const externalIds = await tx.query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, id),
        notDeleted(productExternalId),
      ),
    });
    const updatedAt = new Date();
    await tx
      .update(product)
      .set({ updatedAt })
      .where(and(eq(product.id, id), notDeleted(product)));
    const changes = computeChanges(
      { externalIds: beforeIds },
      { externalIds },
      ["externalIds"],
    );
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: id,
        action: "update",
        changes,
      });
    }
    const pricing = await loadProductPricing(tx, [before]);
    return dbProductToTopLevelAPI({
      ...before,
      pricing: pricing.get(before.id) ?? resolveProductPricing(before.price),
      updatedAt,
      externalIds,
      images: [],
    });
  });

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

  const values = {
    name: data.name,
    manufacturer: data.manufacturer ?? UNSPECIFIED_MANUFACTURER,
    upc: data.upc ?? null,
    fdc_id: data.fdc_id ?? null,
    model: data.model ?? null,
    expectedQuantity: data.expectedQuantity ?? null,
    ingredientId: data.ingredientId ?? null,
    price: data.price ?? null,
    category,
    // Preserve timestamps if provided (for sync restore)
    ...(data.createdAt && { createdAt: data.createdAt }),
    ...(data.updatedAt && { updatedAt: data.updatedAt }),
  };

  // An explicit `shortcode` only comes from the import/restore path, which is
  // replaying a code that already exists; everything else mints one through
  // `insertWithShortcode` so it gets the collision retry.
  const newProduct = data.shortcode
    ? await insertAndReturn(db, product, {
        ...values,
        shortcode: data.shortcode,
      })
    : await insertWithShortcode(db, "product", values);

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "product",
    entityId: newProduct.id,
    action: "create",
  });

  return dbProductToTopLevelAPI({
    ...newProduct,
    pricing: resolveProductPricing(newProduct.price),
    images: [],
    externalIds: [],
  });
};

/**
 * Per-retaining-edge dependent fetch for {@link deleteProducts}, keyed off
 * `ProductRetainingEdgeKey` (derived from {@link PRODUCT_EDGE_ROLES}, see
 * `./edge-roles`). `Record` over that type requires an entry for every
 * acquisition/history edge, so adding one to `PRODUCT_EDGE_ROLES` is a
 * compile error here until it's wired up — the same completeness guarantee
 * `IMAGE_HARD_DELETE` gives `deleteImages` in `repo/image.ts`, extended to a
 * shape (a `.query.<table>.findMany` call) a flat disposition string can't
 * express, since each acquisition edge lives on a different table.
 */
const PRODUCT_RETAINING_DEPENDENTS: Record<
  ProductRetainingEdgeKey,
  (
    tx: DrizzleTransaction,
    ids: ProductId[],
  ) => Promise<Array<{ productId: ProductId | null }>>
> = {
  "InventoryEntry.productId": (tx, ids) =>
    tx.query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.productId, ids),
        notDeleted(inventoryEntry),
      ),
      columns: { productId: true },
    }),
  "Expense.productId": (tx, ids) =>
    tx.query.expense.findMany({
      where: and(inArray(expense.productId, ids), notDeleted(expense)),
      columns: { productId: true },
    }),
  "Task.subjectProductId": async (tx, ids) => {
    const rows = await tx.query.task.findMany({
      where: and(inArray(task.subjectProductId, ids), notDeleted(task)),
      columns: { subjectProductId: true },
    });
    return rows.map(({ subjectProductId }) => ({
      productId: subjectProductId,
    }));
  },
  "ProjectToolUsage.productId": (tx, ids) =>
    tx.query.projectToolUsage.findMany({
      where: and(
        inArray(projectToolUsage.productId, ids),
        notDeleted(projectToolUsage),
      ),
      columns: { productId: true },
    }),
};

/**
 * Soft delete products by setting deletedAt timestamp.
 * Also soft deletes related unit mappings and images.
 * Throws if any product has live acquisition evidence or durable work history
 * (inventory, expenses, or tasks — see `PRODUCT_EDGE_ROLES` in
 * `./edge-roles`).
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

    // Safety check: don't delete a product with live acquisition evidence or
    // durable work history.
    // This used to be two hand-written checks (inventory, then expenses) kept
    // in sync with `findOrphanedProducts` (repo/problems/detectors-product.ts)
    // only by a prose comment — "Inventory and expenses are Product's two
    // acquisition edges, so findOrphanedProducts and this guard must agree on
    // both" — which is exactly the kind of agreement a reviewer can miss
    // (checking only inventory here once made that detector's false
    // positives executable). Both now read `PRODUCT_EDGE_ROLES`, so which
    // edges block a delete can't drift between the two call sites: adding an
    // acquisition/history edge there is a compile error in both until each is
    // wired up. Permitting an expense-linked delete used to be deliberate too — the
    // dangling link degraded to a null display name via
    // resolveLiveJoinName — but that was reversed: the ledger's net cost and
    // owned/sold window are derived from these rows, and a nameless product
    // silently corrupts that derivation with no restore path.
    for (const [key, disposition] of Object.entries(
      PRODUCT_DELETE_EDGE_POLICY,
    )) {
      // Drive off the delete policy's own `block` effect rather than excluding
      // a role: the roles are shared vocabulary, so a negative filter would
      // silently promote any newly-introduced role (e.g. the `media` role
      // `ProductImage.productId` now carries) into a delete blocker.
      if (disposition.effect !== "block") continue;
      const fetchDependents =
        PRODUCT_RETAINING_DEPENDENTS[key as ProductRetainingEdgeKey];
      const dependents = await fetchDependents(tx, ids);
      await assertNoDependents({
        offendingParentIds: dependents.map((d) => d.productId),
        fetchNames: (failedIds) =>
          tx.query.product.findMany({
            where: inArray(product.id, failedIds),
            columns: { name: true },
          }),
        reason: disposition.reason,
        message: (count, names) =>
          `Cannot delete ${count} product(s): ${names} have ${disposition.label}. Remove them first.`,
      });
    }

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

/**
 * What `deleteProducts` would do to the given products, without doing it.
 *
 * Reads the SAME `PRODUCT_DELETE_EDGE_POLICY` and the same per-edge dependent
 * fetchers the mutation does, so the preview cannot claim a delete will succeed
 * that the guard above then refuses — the two share one declaration of which
 * edges block, not two hand-kept copies.
 *
 * Advisory only. `deleteProducts` still re-runs every check inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteProducts = async (
  db: Database,
  ids: ProductId[],
): Promise<{ blockers: ImpactItem[]; changes: ImpactItem[] }> => {
  const dbClient = getDb(db);

  const blockers: (ImpactItem | null)[] = [];
  for (const [key, disposition] of Object.entries(PRODUCT_DELETE_EDGE_POLICY)) {
    if (disposition.effect !== "block") continue;
    const dependents = await PRODUCT_RETAINING_DEPENDENTS[
      key as ProductRetainingEdgeKey
    ](dbClient as unknown as DrizzleTransaction, ids);
    const byTargetId: Record<string, number> = {};
    for (const { productId } of dependents) {
      if (productId) byTargetId[productId] = (byTargetId[productId] ?? 0) + 1;
    }
    blockers.push(
      impact({
        disposition,
        edgeKey: key,
        label: disposition.label,
        byTargetId,
      }),
    );
  }

  // Everything the delete cascades. Each is a `soft-delete` disposition on the
  // same policy, so adding an edge there surfaces here without a code change.
  const cascades: Array<[string, PgTable, PgColumn, string]> = [
    [
      "ProductExternalId.productId",
      productExternalId,
      productExternalId.productId,
      "external ids",
    ],
    [
      "ProductUnitMappings.productId",
      productUnitMappings,
      productUnitMappings.productId,
      "unit mappings",
    ],
    ["ProductImage.productId", productImage, productImage.productId, "images"],
  ];

  const changes: (ImpactItem | null)[] = [];
  for (const [edgeKey, table, column, label] of cascades) {
    const disposition =
      PRODUCT_DELETE_EDGE_POLICY[
        edgeKey as keyof typeof PRODUCT_DELETE_EDGE_POLICY
      ];
    changes.push(
      impact({
        disposition,
        edgeKey,
        label,
        byTargetId: await countByTarget(dbClient, table, column, ids),
      }),
    );
  }

  return { blockers: present(blockers), changes: present(changes) };
};
export type ProductRepoCreateInput = Omit<
  ProductCreateInput,
  "ingredientId"
> & {
  ingredientId: IngredientId | null;
};

export type ProductRepoUpdateData = Omit<
  ProductUpdateInput["data"],
  "ingredientId"
> & {
  ingredientId?: IngredientId | null;
};
