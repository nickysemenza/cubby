import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  displayGtin,
  type ExternalIdKind,
  GTIN_SOURCE,
  storedExternalIdUrl,
} from "@cubby/schemas/external-id";
import {
  type IngredientId,
  type LocationId,
  type ProductId,
  unsafeImageShortcode,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  ProductBulkStockTrackedInput,
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
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import {
  and,
  arrayOverlaps,
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
import type { PgColumn } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  expense,
  image,
  inventoryEntry,
  location,
  product,
  productComponent,
  productConversionCoverage,
  productExternalId,
  productImage,
  productUnitMappings,
  projectToolUsage,
  purchase,
  purchaseProduct,
  task,
  wishCandidate,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditEntryInput,
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
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  presenceCondition,
  rangeConditions,
  relations,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";
import { resolveEstablishedManufacturer } from "~/server/repo/label-canonical";
import { loadLocationAncestorsWithIds } from "~/server/repo/location/tree";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  currentProductConversionCoverageCondition,
  markProductConversionCoverageInputStale,
} from "./conversion-coverage";
import {
  PRODUCT_DELETE_EDGE_POLICY,
  type ProductRetainingEdgeKey,
} from "./edge-roles";
import {
  loadPrimaryGtins,
  productHasGtin,
  productMatchesGtinTerm,
} from "./gtin";
import {
  dbProductToAPI,
  dbProductToListAPI,
  dbProductToPickerItemAPI,
  dbProductToTopLevelAPI,
} from "./mappers";
import { ownershipExitExpensePredicate } from "./ownership";
import {
  derivedPriceFilterSql,
  effectiveProductPriceSql,
  enrichProductRowsWithPricing,
  loadEffectiveProductPricesById,
  loadProductPricing,
  resolveProductPricing,
} from "./pricing";
import {
  enrichProductRowsWithQuantityLedger,
  expectedQuantityFilterSql,
  expectedQuantitySql,
  hasUnknownAcquisitionLinesSql,
  hasUnknownQuantityLinesSql,
  loadProductPickerQuantities,
  onHandUnitsFilterSql,
  onHandUnitsSql,
  quantityVarianceSql,
} from "./quantity-ledger";
import type { ProductDeepDB } from "./types";
import {
  assertNoCanonicalPriceMapping,
  ensureSlotPrimaries,
  externalIdSlotUnchanged,
  externalIdsContainIsbn,
  foldGtinIntoExternalIds,
  resolvePrimaryProductCodeInput,
  syncPrimaryGtin,
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

  if (sort.orderBy === "expectedQuantity") {
    return [sql.raw(`${expectedQuantitySql()} ${dirSql}`)];
  }

  if (sort.orderBy === "quantityVariance") {
    return [sql.raw(`${quantityVarianceSql()} ${dirSql}`)];
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

  if (sort.orderBy === "primaryGtin") {
    return [
      sql.raw(
        `(SELECT pei."externalId" FROM "ProductExternalId" pei ` +
          `WHERE pei."productId" = "product"."id" AND pei."source" = 'gtin' AND pei."deletedAt" IS NULL ` +
          `ORDER BY pei."isPrimary" DESC, pei."createdAt", pei."id" LIMIT 1) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "identity_strength") {
    return [
      // A barcode outranks other external ids because this sort IS the
      // enrichment worklist: a barcode resolves to USDA and to the UPC
      // provider, and an ASIN resolves to neither. Two EXISTS rather than one
      // aggregate — CASE is sequential, so the second only runs for products
      // with no barcode. The `<> ''` guard the scalar needed is gone:
      // `externalId` is notNull and the gtin CHECK makes an empty value
      // unrepresentable.
      sql.raw(`CASE
        WHEN EXISTS (SELECT 1 FROM "ProductExternalId" pei WHERE pei."productId" = "product"."id" AND pei."deletedAt" IS NULL AND pei."source" = 'gtin') THEN 0
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
  const priced = await enrichProductRowsWithPricing(db, [row]);
  return (
    await hydrateProductLocationBreadcrumbs(
      db,
      await enrichProductRowsWithQuantityLedger(db, priced),
    )
  )[0];
};

/** Resolve location breadcrumbs and identity-product covers in batch; preserve both relationship directions. */
const hydrateProductLocationBreadcrumbs = async (
  db: Database,
  rows: ProductDeepDB[],
): Promise<ProductDeepDB[]> => {
  const locationIds = uniq(
    rows.flatMap((row) => [
      ...row.inventoryEntry.map((entry) => entry.location.id),
      ...(row.locations ?? []).map((loc) => loc.id),
    ]),
  );
  const ancestorsById = await loadLocationAncestorsWithIds(db, locationIds);
  const displayImages = await resolveEntityDisplayImages(
    db,
    uniq([
      ...locationIds,
      ...[...ancestorsById.values()].flatMap((chain) =>
        chain.map((rung) => rung.locationId),
      ),
    ]).map((entityId) => ({ entityType: "location" as const, entityId })),
  );
  const displayImageOf = (id: LocationId) =>
    displayImages.get(entityRefKey("location", id)) ?? null;
  const breadcrumbOf = (id: LocationId) =>
    (ancestorsById.get(id) ?? []).map(({ locationId, ...rung }) => ({
      ...rung,
      displayImage: displayImageOf(locationId),
    }));

  return rows.map((row) => ({
    ...row,
    inventoryEntry: row.inventoryEntry.map((entry) => ({
      ...entry,
      location: {
        ...entry.location,
        ancestors: breadcrumbOf(entry.location.id),
        displayImage: displayImageOf(entry.location.id),
      },
    })),
    locations: row.locations?.map((loc) => ({
      ...loc,
      ancestors: breadcrumbOf(loc.id),
      displayImage: displayImageOf(loc.id),
    })),
  }));
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
});

export const getProductByID = (db: Database, id: ProductId) =>
  productReader.getByID(db, id);

export const getProductsForFoodLookup = async (
  db: Database,
  ids: ProductId[],
) => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.product.findMany({
    where: and(inArray(product.id, ids), notDeleted(product)),
    columns: { id: true, fdc_id: true },
  });
  const gtins = await loadPrimaryGtins(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    ...row,
    primaryGtin: gtins.get(row.id) ?? null,
  }));
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
    .orderBy(asc(productImage.sortOrder), asc(productImage.createdAt));

  for (const row of rows) {
    result[row.productId]?.push({
      ...row.image,
      id: unsafeImageShortcode(row.image.shortcode),
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
  const ledgered = await hydrateProductLocationBreadcrumbs(
    db,
    await enrichProductRowsWithQuantityLedger(db, priced),
  );
  return ledgered.map((row) => dbProductToAPI(row, qualities.get(row.id)!));
};

export const productList = async (
  db: Database,
  filters: ProductFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
  readIntent: ListReadIntent = "page",
) => {
  const dbClient = getDb(db);

  const requestedLocationCodes = filters.locationIdFilter
    ? [filters.locationIdFilter].flat()
    : [];
  const requestedIngredientCodes = filters.ingredientIdFilter
    ? [filters.ingredientIdFilter].flat()
    : [];
  const [selectedLocationIds, selectedIngredientIds] = await Promise.all([
    resolveAllPresent(db, "location", requestedLocationCodes),
    resolveAllPresent(db, "ingredient", requestedIngredientCodes),
  ]);

  // Cross-entity filters must stay uncorrelated id-set subqueries shared by all product list query paths.
  const productIdsWithLiveInventory = dbClient
    .select({ productId: inventoryEntry.productId })
    .from(inventoryEntry)
    .innerJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(notDeleted(inventoryEntry));

  const productIdsWithDuplicatePlacement = dbClient
    .select({ productId: inventoryEntry.productId })
    .from(inventoryEntry)
    .innerJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(notDeleted(inventoryEntry))
    .groupBy(inventoryEntry.productId, inventoryEntry.placement)
    .having(sql`count(*) > 1`);

  // Products a Location IS an instance of. Deliberately NOT folded into
  // `productIdsWithLiveInventory`: that set backs the `location` column's
  // presence filter, and the column renders `inventoryEntry` rows, so widening
  // it would make the filter and the cell disagree — a shelf-less bin would
  // read "has inventory" over an empty cell. `onHandUnitsSql` counts both, so
  // the variance gate below unions them explicitly instead.
  const productIdsServingAsLocations = dbClient
    .select({ productId: location.productId })
    .from(location)
    .where(and(notDeleted(location), isNotNull(location.productId)));

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

  const productIdsWithExpenses = dbClient
    .select({ productId: expense.productId })
    .from(expense)
    .where(and(notDeleted(expense), isNotNull(expense.productId)));

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

  // Kit membership requires live parent and component rows; do not approximate liveness with stale joins.
  const partsAccountedKitsSql = (productId: PgColumn) =>
    sql`(SELECT min(floor(COALESCE(${sql.raw(onHandUnitsSql("kac_p"))}, 0) / kac."quantity"))
           FROM "ProductComponent" kac
           JOIN "Product" kac_p
             ON kac_p."id" = kac."componentProductId" AND kac_p."deletedAt" IS NULL
          WHERE kac."parentProductId" = ${productId}
            AND kac."deletedAt" IS NULL)`;

  const productIdsWithComponents = dbClient
    .select({ productId: productComponent.parentProductId })
    .from(productComponent)
    .where(notDeleted(productComponent));

  // This is the entity-list form of the sold-but-still-stocked diagnostic.
  // The quantity ledger remains the authority for expected quantity and unknown
  // acquisition lines; the shared exit predicate prevents ordinary
  // refunds/adjustments from reading as an ownership exit while including $0
  // hand-entered discards.
  const productIdsWithRecordedDisposal = dbClient
    .select({ productId: expense.productId })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        isNotNull(expense.productId),
        ownershipExitExpensePredicate(dbClient),
      ),
    );

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

  const gtinRows = dbClient
    .select({ productId: productExternalId.productId })
    .from(productExternalId)
    .where(
      and(
        notDeleted(productExternalId),
        eq(productExternalId.source, GTIN_SOURCE),
      ),
    );
  const productIdsWithGtin = gtinRows;

  const selectedDataGaps = filters.dataGap ? [filters.dataGap].flat() : [];
  const needsData = productNeedsDataCondition();

  // Mirrors `foodLookupParamFromProduct` returning null: no explicit fdc_id AND
  // no barcode to auto-match. This is the closest pure-SQL predicate — it
  // cannot know whether the USDA worker resolves a food for that key, which is
  // why the filter is labelled "USDA key". Passed as `presenceCondition`'s
  // `emptyWhen` so "has" is derived as not(this) and the two branches can't
  // drift.
  // The outer parens are load-bearing, same as TAGS_ARE_EMPTY in recipe/crud.ts:
  // `presenceCondition` derives "has" as `not(this)`, and drizzle's `not()`
  // doesn't add its own. Unparenthesized, `NOT a IS NULL AND NOT EXISTS ...`
  // binds as `(NOT a IS NULL) AND (NOT EXISTS ...)` — i.e. "has fdc_id AND has
  // no barcode", which silently drops every barcode-only product from "has".
  const NO_USDA_KEY = sql`(${product.fdc_id} IS NULL AND NOT EXISTS (
    SELECT 1 FROM "ProductExternalId" pei
    WHERE pei."productId" = ${product.id}
      AND pei."source" = ${GTIN_SOURCE}
      AND pei."deletedAt" IS NULL))`;

  const NO_TAGS = sql`(cardinality(${product.tags}) = 0)`;

  // Build where conditions - always filter out deleted items
  const whereClause = buildSearchConditions(
    product,
    [
      { column: product.name, term: filters.nameFilter },
      { column: product.manufacturer, term: filters.manufacturerFilter },
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
      idSetPresence(
        product.id,
        filters.servingAsLocationPresenceFilter,
        productIdsServingAsLocations,
      ),
      filters.inventoryMultiplicity === "duplicate_within_placement"
        ? and(
            eq(product.expectedQuantity, 1),
            inArray(product.id, productIdsWithDuplicatePlacement),
          )
        : undefined,
      filters.kitAccounting === "double_counted"
        ? and(
            sql`${onHandUnitsFilterSql(product.id)} > 0`,
            sql`${partsAccountedKitsSql(product.id)} > 0`,
            sql`${onHandUnitsFilterSql(product.id)} + ${partsAccountedKitsSql(product.id)} > ${expectedQuantityFilterSql(product.id)}`,
          )
        : undefined,
      filters.ownershipReconciliation === "disposed_still_on_hand"
        ? and(
            inArray(product.id, productIdsWithRecordedDisposal),
            sql`${onHandUnitsFilterSql(product.id)} > 0`,
            sql`${expectedQuantityFilterSql(product.id)} <= 0`,
            sql`NOT ${hasUnknownAcquisitionLinesSql(product.id)}`,
          )
        : undefined,
      filters.conversionCoverage === "partial"
        ? inArray(
            product.id,
            dbClient
              .select({ id: productConversionCoverage.productId })
              .from(productConversionCoverage)
              .where(
                and(
                  currentProductConversionCoverageCondition(),
                  eq(productConversionCoverage.coverageTier, "partial"),
                ),
              ),
          )
        : undefined,
      filters.conversionTopology === "islanded"
        ? inArray(
            product.id,
            dbClient
              .select({ id: productConversionCoverage.productId })
              .from(productConversionCoverage)
              .where(
                and(
                  currentProductConversionCoverageCondition(),
                  sql`${productConversionCoverage.islandCount} >= 2`,
                ),
              ),
          )
        : undefined,
      ...rangeConditions(
        sql`(SELECT count(*) FROM "Expense" e WHERE e."productId" = ${product.id} AND e."deletedAt" IS NULL)`,
        filters,
        "expenseCount",
      ),
      ...rangeConditions(
        sql`(SELECT COALESCE(sum(e."cost"), 0) FROM "Expense" e WHERE e."productId" = ${product.id} AND e."deletedAt" IS NULL)`,
        filters,
        "expenseTotal",
      ),
      ...rangeConditions(
        expectedQuantityFilterSql(product.id),
        filters,
        "expectedQuantity",
      ),
      // Scoped to products that are BOTH stocked and in the ledger. Neither
      // half is optional, and both were measured against production:
      //
      //  - Without "stocked", an unstocked product has a variance of 0 - 0, so
      //    "matched" would claim every untouched product is reconciled and
      //    "mismatched" would be dominated by things correctly sold off.
      //  - Without "in the ledger", 126 of the 218 hits are stocked products
      //    with no product-linked Expense at all. Those read as a variance of
      //    the full shelf count, but the disagreement is really "no purchase
      //    history" — a provenance gap `findOrphanedProducts` and the
      //    data-quality checks already own — and they swamp the 92 rows where
      //    a real ledger and a real shelf genuinely disagree.
      filters.quantityVarianceFilter !== undefined
        ? and(
            // Present ANYWHERE — on a shelf or in service as a bin. The gate
            // used to be shelf-only while the comparison it guards
            // (`onHandUnitsFilterSql`) already counted locations, so the two
            // halves of one predicate disagreed about what "stocked" means and
            // this view could not see a product held entirely as containers.
            or(
              inArray(product.id, productIdsWithLiveInventory),
              inArray(product.id, productIdsServingAsLocations),
            ),
            inArray(product.id, productIdsWithExpenses),
            filters.quantityVarianceFilter === "mismatched"
              ? sql`${onHandUnitsFilterSql(product.id)} <> ${expectedQuantityFilterSql(product.id)}`
              : sql`${onHandUnitsFilterSql(product.id)} = ${expectedQuantityFilterSql(product.id)}`,
          )
        : undefined,
      filters.unknownQuantityLinesFilter === "has"
        ? hasUnknownQuantityLinesSql(product.id)
        : filters.unknownQuantityLinesFilter === "none"
          ? sql`NOT ${hasUnknownQuantityLinesSql(product.id)}`
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
        filters.componentPresenceFilter,
        productIdsWithComponents,
      ),
      filters.miscBucketFilter === "has"
        ? sql`lower(${product.name}) LIKE 'misc:%'`
        : filters.miscBucketFilter === "none"
          ? sql`lower(${product.name}) NOT LIKE 'misc:%'`
          : undefined,
      idSetPresence(
        product.id,
        filters.externalIdPresenceFilter ??
          (externalSources && externalSources.length > 0 ? "has" : undefined),
        productIdsWithExternalIds,
      ),
      presenceCondition(product.model, filters.modelPresenceFilter),
      idSetPresence(product.id, filters.upcPresenceFilter, productIdsWithGtin),
      filters.upcFilter ? productMatchesGtinTerm(filters.upcFilter) : undefined,
      presenceCondition(product.notes, filters.notesPresenceFilter),
      presenceCondition(
        product.stockTracked,
        filters.stockTrackedPresenceFilter,
      ),
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
      // Effective price is `explicit ?? derived`, so both directions read the
      // derived half through `derivedPriceFilterSql` — the same projection the
      // price column renders and the list sorts by, kit share included.
      filters.pricePresenceFilter === "none"
        ? and(
            isNull(product.price),
            sql`${derivedPriceFilterSql(product.id)} IS NULL`,
          )
        : filters.pricePresenceFilter === "has"
          ? or(
              isNotNull(product.price),
              sql`${derivedPriceFilterSql(product.id)} IS NOT NULL`,
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

  if (readIntent === "count") {
    return {
      data: [],
      count: await countWhere(db, product, whereClause),
      // Count-only consumers deliberately do not request table footers.
      sums: { price: 0, expenseTotal: 0 },
    };
  }

  const orderByArray = productListOrderBy(sorts, groupBy);

  const { take, skip } = buildTakeSkip(pagination);
  const skipAggregates = readIntent === "sample";

  const [{ data: results, count: totalCount }, aggregates, expenseAggregates] =
    await Promise.all([
      executeListQueryWithCount({
        kind: readIntent,
        rows: () =>
          getDb(db).query.product.findMany({
            where: whereClause,
            orderBy: orderByArray,
            limit: take,
            offset: skip,
            ...relations.product.list,
          }),
        count: () => countWhere(db, product, whereClause),
      }),
      skipAggregates
        ? Promise.resolve([{ priceSum: 0 }])
        : getDb(db)
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
      skipAggregates
        ? Promise.resolve([{ expenseTotalSum: 0 }])
        : getDb(db)
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
  const ledgeredResults = await enrichProductRowsWithQuantityLedger(
    db,
    pricedResults,
  );
  const products = ledgeredResults.map((prod) =>
    dbProductToListAPI({
      ...prod,
      dataQuality: qualities.get(prod.id)!,
    }),
  );

  const priceSum = Number(aggregates[0]?.priceSum ?? 0);
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
 * First displayable product image in explicit display order, loaded once for a
 * batch of picker or relationship rows. This intentionally returns only the
 * cover URL; full image projections still use `getProductImagesByProductIds`.
 */
export const getProductCoverImageUrlsByProductIds = async (
  db: Database,
  ids: ProductId[],
): Promise<Map<ProductId, string>> => {
  const byId = new Map<ProductId, string>();
  if (ids.length === 0) return byId;

  const rows = await getDb(db)
    .select({ productId: productImage.productId, url: image.url })
    .from(productImage)
    .innerJoin(image, eq(image.id, productImage.imageId))
    .where(
      and(
        inArray(productImage.productId, ids),
        notDeleted(productImage),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .orderBy(
      productImage.productId,
      asc(productImage.sortOrder),
      asc(productImage.createdAt),
      asc(productImage.id),
    );

  for (const row of rows) {
    if (!byId.has(row.productId)) byId.set(row.productId, row.url);
  }
  return byId;
};

/**
 * Lightweight product search for typeahead/picker comboboxes.
 *
 * Returns the product picker shape only — it deliberately skips the inventory /
 * ingredient / unit-mapping / external-id relation graph that `productList`
 * pulls. Pickers get identity, compact quantity evidence, and one batched cover
 * URL without pretending to carry full product rows.
 */
export const productSearch = async (
  db: Database,
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
    filters.upcFilter ? productMatchesGtinTerm(filters.upcFilter) : undefined,
    eqAny(product.category, filters.categoryFilter),
  );

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

  const resultIds = results.map((result) => result.id);
  const [quantities, coverImageUrls, prices] = await Promise.all([
    loadProductPickerQuantities(db, resultIds),
    getProductCoverImageUrlsByProductIds(db, resultIds),
    loadEffectiveProductPricesById(db, resultIds),
  ]);
  const data = results.map((result) =>
    dbProductToPickerItemAPI({
      ...result,
      ...quantities.get(result.id)!,
      price: prices.get(result.id) ?? null,
      coverImageUrl: coverImageUrls.get(result.id) ?? null,
    }),
  );

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
      category: true,
    },
  });
  const rowIds = rows.map((row) => row.id);
  const [quantities, coverImageUrls, prices] = await Promise.all([
    loadProductPickerQuantities(db, rowIds),
    getProductCoverImageUrlsByProductIds(db, rowIds),
    loadEffectiveProductPricesById(db, rowIds),
  ]);
  const byId = new Map(
    rows.map((row) => [
      row.id,
      dbProductToPickerItemAPI({
        ...row,
        ...quantities.get(row.id)!,
        price: prices.get(row.id) ?? null,
        coverImageUrl: coverImageUrls.get(row.id) ?? null,
      }),
    ]),
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

  // Retargeted from `Product_upc_key` to the identifier table's global unique,
  // which is now what stops two live products claiming one barcode. This is not
  // redundant with `assertExternalIdsAvailable` — that is a pre-check, and this
  // is the backstop `findOrCreateByGtin` recovers a concurrent scan on. It also
  // catches strictly more: the old index compared 12 digits to 13, so two
  // encodings of one barcode both got through.
  if (constraint.includes("source_kind_externalId") && data.upc) {
    const existing = await getDb(db).query.product.findFirst({
      where: and(productHasGtin(data.upc), notDeleted(product)),
      columns: { name: true, shortcode: true },
    });
    throw createAppError(
      "PRODUCT_ALREADY_EXISTS",
      `Barcode ${displayGtin(data.upc)} is already used by ${
        existing
          ? `${existing.shortcode} “${existing.name}”`
          : "another product"
      }.`,
      error,
    );
  }

  if (constraint.includes("name_manufacturer")) {
    // Re-read the blocker rather than echoing the input back. Without this the
    // message says only that *something* named this exists, and the next step
    // is always a list/search call to find out what — so name it here. The
    // conflicting row is what the caller needs to merge into, rename, or skip.
    const existing = await getDb(db).query.product.findFirst({
      where: and(
        eq(product.name, data.name),
        eq(product.manufacturer, data.manufacturer),
        notDeleted(product),
      ),
      columns: { name: true, shortcode: true },
    });
    throw createAppError(
      "PRODUCT_ALREADY_EXISTS",
      existing
        ? `A product named “${data.name}” by “${data.manufacturer}” already exists: ${existing.shortcode}.`
        : `A product named “${data.name}” by “${data.manufacturer}” already exists.`,
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

  // Per-each price is the scalar `productData.price` column; a canonical
  // "1 each = $X" mapping would duplicate it (per-measure money mappings are OK).
  if (unitMappings) assertNoCanonicalPriceMapping(unitMappings);

  // Use a transaction to ensure atomicity. On a unique violation (e.g. another
  // product already claims this barcode), translate the raw DB error into a
  // clear CONFLICT message — the lookups run on `db` because the tx is aborted.
  try {
    const created = await withTransaction(db, async (tx) => {
      // A bare `upc` becomes a `gtin` identifier row rather than a column, and
      // is folded into the payload so it cannot be lost to (or lose to) an
      // explicit `externalIds` on the same call.
      const { upc, isbn, ...columnData } = productData;
      const incomingGtin = resolvePrimaryProductCodeInput({ upc, isbn });
      const desiredExternalIds =
        incomingGtin === undefined || incomingGtin === null
          ? (externalIds ?? [])
          : foldGtinIntoExternalIds(externalIds ?? [], incomingGtin);
      const category = hasFoodIndicators({ ...data, ingredientId })
        ? "food"
        : externalIdsContainIsbn(desiredExternalIds)
          ? "books"
          : (data.category ?? null);
      await assertExternalIdsAvailable(tx, desiredExternalIds);
      const newProduct = await insertWithShortcode(tx, "product", {
        ...columnData,
        manufacturer: await resolveEstablishedManufacturer(
          tx,
          productData.manufacturer,
        ),
        category,
        ingredientId: ingredientId ?? null,
      });

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

      if (desiredExternalIds.length > 0) {
        await tx.insert(productExternalId).values(
          desiredExternalIds.map((eid) => ({
            productId: newProduct.id,
            source: eid.source.trim().toLowerCase(),
            kind: eid.kind,
            externalId: eid.externalId,
            url: storedExternalIdUrl(eid),
            isPrimary: eid.isPrimary ?? true,
          })),
        );
      }

      let images: Array<typeof image.$inferSelect> = [];
      if (pendingImageIds && pendingImageIds.length > 0) {
        // `pendingImageIds` are public `IMG-` codes; both the join-table write
        // and the read-back below key on `Image.id`, so resolve once and use
        // the uuids for both.
        const resolvedImageIds = await resolveAllPresent(
          tx,
          "image",
          pendingImageIds,
        );

        await associatePendingImages(
          tx,
          productImage,
          "productId",
          newProduct.id,
          resolvedImageIds,
        );

        images = await tx
          .select()
          .from(image)
          .where(inArray(image.id, resolvedImageIds));
      }

      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: newProduct.id,
        action: "create",
      });

      const createdExternalIds =
        desiredExternalIds.length > 0
          ? await tx.query.productExternalId.findMany({
              where: eq(productExternalId.productId, newProduct.id),
            })
          : [];

      return { ...newProduct, images, externalIds: createdExternalIds };
    });
    const qualities = await loadProductDataQualities(db, [created.id]);
    return dbProductToTopLevelAPI({
      ...created,
      pricing: resolveProductPricing(created.price),
      dataQuality: qualities.get(created.id)!,
    });
  } catch (error) {
    await throwIfDuplicateProduct(db, data, error);
    throw error;
  }
};

/**
 * `detachedImageKeys` are R2 objects that `removeImageIds` reaped. They have no
 * rollback, so they ride out of the transaction rather than being dropped inside
 * it; `updateProductWithFood` drains them once the commit is real.
 */
export const updateProduct = async (
  db: Database,
  id: ProductId,
  data: ProductRepoUpdateData,
  actor: ActorContext,
): Promise<{ product: ProductTopLevelOut; detachedImageKeys: string[] }> => {
  const {
    ingredientId,
    unitMappings,
    externalIds,
    pendingImageIds,
    removeImageIds,
    imageOrder,
    ...productData
  } = data;

  let detachedImageKeys: string[] = [];

  // The identity this update lands on, captured inside the transaction for the
  // duplicate handler outside it — a rename collides on the SAME indexes a
  // create does, and used to surface as the generic "a product with that name,
  // manufacturer already exists" with no way to tell which product that was.
  let effectiveIdentity: {
    name: string;
    manufacturer: string;
    upc?: string | null;
  } | null = null;

  try {
    const updatedProduct = await withTransaction(db, async (tx) => {
      const beforeProduct = await tx.query.product.findFirst({
        where: and(eq(product.id, id), notDeleted(product)),
      });

      if (!beforeProduct) {
        throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
      }

      const beforeExternalIds = await tx.query.productExternalId.findMany({
        where: and(
          eq(productExternalId.productId, id),
          notDeleted(productExternalId),
        ),
      });

      // A canonical "1 each = $X" mapping duplicates the price column; reject it.
      if (unitMappings !== undefined)
        assertNoCanonicalPriceMapping(unitMappings);

      const { upc, isbn, ...columnData } = productData;
      const incomingGtin = resolvePrimaryProductCodeInput({ upc, isbn });
      const desiredExternalIds =
        externalIds === undefined
          ? undefined
          : incomingGtin === undefined
            ? externalIds
            : foldGtinIntoExternalIds(externalIds, incomingGtin);
      effectiveIdentity = {
        name: columnData.name ?? beforeProduct.name,
        manufacturer: columnData.manufacturer ?? beforeProduct.manufacturer,
        upc: incomingGtin ?? undefined,
      };
      const updateData: {
        name?: string;
        aliases?: string[];
        tags?: string[];
        manufacturer?: string;
        category?: ProductCategory | null;
        fdc_id?: number | null;
        model?: string | null;
        expectedQuantity?: number | null;
        ingredientId?: IngredientId | null;
        price?: number | null;
      } = { ...columnData };

      if (ingredientId !== undefined) {
        updateData.ingredientId = ingredientId;
      }

      const resultingProduct = {
        fdc_id: updateData.fdc_id ?? beforeProduct.fdc_id,
        ingredientId: updateData.ingredientId ?? beforeProduct.ingredientId,
      };
      const resultingExternalIds =
        desiredExternalIds ??
        (incomingGtin === undefined
          ? beforeExternalIds
          : incomingGtin === null
            ? beforeExternalIds.filter((entry) => !entry.isPrimary)
            : [
                ...beforeExternalIds.filter(
                  (entry) => entry.externalId !== incomingGtin,
                ),
                { source: GTIN_SOURCE, externalId: incomingGtin },
              ]);
      if (hasFoodIndicators(resultingProduct)) {
        updateData.category = "food";
      } else if (externalIdsContainIsbn(resultingExternalIds)) {
        updateData.category = "books";
      }

      // Wishlist candidates are tools by domain definition. Check the final
      // category after the food-indicator correction too, so a linked ingredient
      // cannot silently reclassify a live candidate out of Tools.
      if (
        updateData.category !== undefined &&
        updateData.category !== "tools"
      ) {
        const candidate = await tx.query.wishCandidate.findFirst({
          where: and(
            eq(wishCandidate.productId, id),
            notDeleted(wishCandidate),
          ),
          columns: { id: true },
        });
        if (candidate) {
          throw createAppError(
            "PRODUCT_HAS_WISH_CANDIDATES",
            "Remove this Product from the Wishlist before changing it out of the Tools category.",
          );
        }
      }

      const updated = await updateLiveAndReturn(tx, product, updateData, id);

      if (unitMappings !== undefined) {
        await syncProductUnitMappings(tx, id, unitMappings);
      }

      // Price, food identity, ingredient coverage opt-outs and stored mappings
      // all participate in the effective conversion graph. Keep an old graph
      // from being presented as a current list/filter result until its rebuild.
      if (
        unitMappings !== undefined ||
        data.price !== undefined ||
        ingredientId !== undefined ||
        data.fdc_id !== undefined ||
        incomingGtin !== undefined
      ) {
        await markProductConversionCoverageInputStale(tx, [id]);
      }

      // AFTER the mapping sync, and gated on either input: valuation routes the
      // entry's amount to money through the mapping graph, so editing the
      // mappings alone can change every valuation, and syncing first would
      // re-derive them from the graph this write is about to replace.
      // (`merge.ts` already orders these correctly.)
      if (data.price !== undefined || unitMappings !== undefined) {
        await syncInventoryValuationsForProduct(tx, id);
      }
      if (externalIds !== undefined) {
        const desired = desiredExternalIds!;
        await assertExternalIdsAvailable(tx, desired, id);
        await syncProductExternalIds(tx, id, desired);
      } else if (incomingGtin !== undefined) {
        await syncPrimaryGtin(tx, id, incomingGtin);
      }
      detachedImageKeys = await syncProductImages(
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

      const currentExternalIdRows = await tx.query.productExternalId.findMany({
        where: and(
          eq(productExternalId.productId, updated.id),
          notDeleted(productExternalId),
        ),
      });

      const changes = computeChanges(
        { ...beforeProduct, externalIds: beforeExternalIds },
        { ...updated, externalIds: currentExternalIdRows },
        [
          "name",
          "aliases",
          "tags",
          "manufacturer",
          "category",
          "externalIds",
          "fdc_id",
          "model",
          "expectedQuantity",
          "ingredientId",
          "price",
        ],
      );

      if (changes) {
        await logAuditEntry(tx, actor, {
          entityType: "product",
          entityId: updated.id,
          action: "update",
          changes,
        });
      }

      const pricing = await loadProductPricing(tx, [updated]);
      const qualities = await loadProductDataQualities(tx, [updated.id]);
      return dbProductToTopLevelAPI({
        ...updated,
        pricing:
          pricing.get(updated.id) ?? resolveProductPricing(updated.price),
        dataQuality: qualities.get(updated.id)!,
        images: productImages,
        externalIds: currentExternalIdRows,
      });
    });
    return { product: updatedProduct, detachedImageKeys };
  } catch (error) {
    // Safe on a clean connection: withTransaction has already rolled back, so
    // the lookup inside runs its own statements rather than inheriting a
    // poisoned transaction (same reasoning as createProduct's handler).
    if (effectiveIdentity) {
      await throwIfDuplicateProduct(db, effectiveIdentity, error);
    }
    throw error;
  }
};

/**
 * Bulk stock-tracking write — the shape of `setExpensesCostType`, and
 * deliberately NOT routed through `updateProduct`.
 *
 * `stockTracked` is a pure worklist decision: it feeds no price, no unit
 * mapping and no quantity, so none of `updateProduct`'s recompute cascade
 * (recipe costing, location valuation, USDA resync) has anything to react to.
 * Running that per row over a several-hundred-row sweep would enqueue a
 * recompute wave for a flag no derivation reads.
 *
 * The audit entries are the point of the loop: this is the one write that
 * makes a product disappear from "Not on a shelf", so a wrong sweep has to be
 * legible after the fact rather than only reversible.
 */
export const setProductsStockTracked = async (
  db: Database,
  input: ProductBulkStockTrackedInput,
  actor: ActorContext,
): Promise<ProductTopLevelOut[]> => {
  const { stockTracked } = input;

  const updatedShortcodes = await withTransaction(db, async (tx) => {
    const ids = await resolveAllPresent(tx, "product", input.ids);
    const before = await tx.query.product.findMany({
      where: and(inArray(product.id, ids), notDeleted(product)),
      columns: { id: true, shortcode: true, stockTracked: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(product)
      .set({ stockTracked })
      .where(and(inArray(product.id, ids), notDeleted(product)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(
        row,
        { id: row.id, shortcode: row.shortcode, stockTracked },
        ["stockTracked"],
      );
      if (changes) {
        auditEntries.push({
          entityType: "product",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.shortcode);
  });

  return getProductsByShortcodes(db, updatedShortcodes);
};

export const patchProductExternalIds = async (
  db: Database,
  id: ProductId,
  input: {
    upsert: Array<{
      source: string;
      kind: ExternalIdKind;
      externalId: string;
      url?: string | null;
      isPrimary?: boolean;
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
      const inSlot = beforeIds.filter(
        (externalId) =>
          externalId.source === source && externalId.kind === entry.kind,
      );
      if (!inSlot.some((row) => row.externalId === entry.expectedExternalId)) {
        throw createAppError(
          "PRODUCT_EXTERNAL_ID_PRECONDITION_FAILED",
          inSlot.length > 0
            ? `Product external ID ${source}/${entry.kind} holds ${inSlot
                .map((row) => row.externalId)
                .join(", ")}, not the expected ${entry.expectedExternalId}.`
            : `Product has no live external ID in slot ${source}/${entry.kind}.`,
        );
      }
    }

    await assertExternalIdsAvailable(tx, input.upsert, id);

    // Slots this call is explicitly removing must never be short-circuited by
    // the unchanged-value check below, even if their pre-removal value
    // happens to match an incoming upsert for the same slot.
    const removedSlots = new Set(
      input.remove.map((r) => `${r.source.trim().toLowerCase()}\0${r.kind}`),
    );

    for (const entry of input.remove) {
      const source = entry.source.trim().toLowerCase();
      await tx
        .update(productExternalId)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(productExternalId.productId, id),
            eq(productExternalId.source, source),
            eq(productExternalId.kind, entry.kind),
            eq(productExternalId.externalId, entry.expectedExternalId),
            notDeleted(productExternalId),
          ),
        );
    }
    for (const entry of input.upsert) {
      const source = entry.source.trim().toLowerCase();
      const isPrimary = entry.isPrimary ?? true;
      const slotRows = await tx.query.productExternalId.findMany({
        where: and(
          eq(productExternalId.productId, id),
          eq(productExternalId.source, source),
          eq(productExternalId.kind, entry.kind),
          notDeleted(productExternalId),
        ),
      });
      const liveSlot = isPrimary
        ? slotRows.find((e) => e.isPrimary)
        : slotRows.find((e) => e.externalId === entry.externalId);
      if (
        liveSlot &&
        !removedSlots.has(`${source}\0${entry.kind}`) &&
        externalIdSlotUnchanged(liveSlot, { ...entry, source })
      ) {
        continue;
      }
      if (!isPrimary) {
        // Secondaries have no per-slot unique to conflict on, so there is
        // nothing to infer; the global (source, kind, externalId) unique is
        // already enforced by `assertExternalIdsAvailable` above.
        if (liveSlot) {
          await tx
            .update(productExternalId)
            .set({
              url: storedExternalIdUrl({ ...entry, source }),
              isPrimary: false,
              updatedAt: new Date(),
            })
            .where(eq(productExternalId.id, liveSlot.id));
        } else {
          await tx.insert(productExternalId).values({
            productId: id,
            source,
            kind: entry.kind,
            externalId: entry.externalId,
            url: storedExternalIdUrl({ ...entry, source }),
            isPrimary: false,
          });
        }
        continue;
      }
      await tx
        .insert(productExternalId)
        .values({
          productId: id,
          source,
          kind: entry.kind,
          externalId: entry.externalId,
          url: storedExternalIdUrl({ ...entry, source }),
          isPrimary: true,
        })
        .onConflictDoUpdate({
          // Must match the index predicate exactly: Postgres infers the arbiter
          // index from this, and `deletedAt IS NULL` alone no longer describes
          // any unique index on these columns.
          target: [
            productExternalId.productId,
            productExternalId.source,
            productExternalId.kind,
          ],
          targetWhere: sql`${productExternalId.isPrimary} AND ${productExternalId.deletedAt} IS NULL`,
          set: {
            externalId: entry.externalId,
            url: storedExternalIdUrl({ ...entry, source }),
            updatedAt: new Date(),
          },
        });
    }
    // Restore the one-primary-per-slot invariant after every write. See
    // `ensureSlotPrimaries` for why this is a repair keyed on live state rather
    // than promotion logic inside the loops.
    await ensureSlotPrimaries(tx, id, [...input.upsert, ...input.remove]);

    const externalIds = await tx.query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, id),
        notDeleted(productExternalId),
      ),
    });
    const changes = computeChanges(
      { externalIds: beforeIds },
      { externalIds },
      ["externalIds"],
    );
    // Every upsert may have been an unchanged-slot no-op (see above) and
    // `remove` may have targeted nothing live; only bump updatedAt / log an
    // audit entry when something actually changed.
    let updatedAt = before.updatedAt;
    if (changes) {
      updatedAt = new Date();
      await tx
        .update(product)
        .set({ updatedAt })
        .where(and(eq(product.id, id), notDeleted(product)));
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: id,
        action: "update",
        changes,
      });
    }
    const pricing = await loadProductPricing(tx, [before]);
    // Data quality depends on the external IDs this call just changed (the
    // amazon_asin/duplicate_external_id checks), so it must be recomputed
    // here rather than reused from `before`.
    const qualities = await loadProductDataQualities(tx, [before.id]);
    return dbProductToTopLevelAPI({
      ...before,
      pricing: pricing.get(before.id) ?? resolveProductPricing(before.price),
      dataQuality: qualities.get(before.id)!,
      updatedAt,
      externalIds,
      images: [],
    });
  });

export const quickCreateProduct = async (
  db: Database,
  data: {
    name: string;
    manufacturer?: string;
    upc?: string | null;
    isbn?: string | null;
    expectedQuantity?: number | null;
    model?: string | null;
    fdc_id?: number | null;
    ingredientId?: IngredientId | null;
    price?: number | null;
    category?: ProductCategory | null;
    shortcode?: string; // Optional shortcode from import (preserves sheet shortcodes)
    createdAt?: Date;
    updatedAt?: Date;
  },
  actor: ActorContext,
): Promise<ProductTopLevelOut> => {
  const incomingGtin = resolvePrimaryProductCodeInput({
    upc: data.upc,
    isbn: data.isbn,
  });
  const category = hasFoodIndicators(data)
    ? "food"
    : incomingGtin != null &&
        externalIdsContainIsbn([
          { source: GTIN_SOURCE, externalId: incomingGtin },
        ])
      ? "books"
      : (data.category ?? null);

  const values = {
    name: data.name,
    manufacturer: await resolveEstablishedManufacturer(
      db,
      data.manufacturer ?? UNSPECIFIED_MANUFACTURER,
    ),
    fdc_id: data.fdc_id ?? null,
    model: data.model ?? null,
    expectedQuantity: data.expectedQuantity ?? null,
    ingredientId: data.ingredientId ?? null,
    price: data.price ?? null,
    category,
    ...(data.createdAt && { createdAt: data.createdAt }),
    ...(data.updatedAt && { updatedAt: data.updatedAt }),
  };

  // Transactional because the barcode is a SECOND row now. This used to be one
  // INSERT, and `findOrCreateByGtin`'s cross-request race recovery leaned on
  // that: a losing racer must commit nothing, or it leaves a barcode-less
  // Product behind for the recovery to find instead of the winner.
  const { newProduct, externalIds } = await withTransaction(db, async (tx) => {
    // An explicit `shortcode` only comes from the import/restore path, which is
    // replaying a code that already exists; everything else mints one through
    // `insertWithShortcode` so it gets the collision retry.
    const inserted = data.shortcode
      ? await insertAndReturn(tx, product, {
          ...values,
          shortcode: data.shortcode,
        })
      : await insertWithShortcode(tx, "product", values);

    if (incomingGtin != null) {
      await syncPrimaryGtin(tx, inserted.id, incomingGtin);
    }

    await logAuditEntry(tx, actor, {
      entityType: "product",
      entityId: inserted.id,
      action: "create",
    });

    const rows =
      incomingGtin == null
        ? []
        : await tx.query.productExternalId.findMany({
            where: eq(productExternalId.productId, inserted.id),
          });
    return { newProduct: inserted, externalIds: rows };
  });

  const qualities = await loadProductDataQualities(db, [newProduct.id]);
  return dbProductToTopLevelAPI({
    ...newProduct,
    pricing: resolveProductPricing(newProduct.price),
    dataQuality: qualities.get(newProduct.id)!,
    images: [],
    externalIds,
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
    tx: DrizzleClient | DrizzleTransaction,
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
  "PurchaseProduct.productId": (tx, ids) =>
    tx.query.purchaseProduct.findMany({
      where: and(
        inArray(purchaseProduct.productId, ids),
        notDeleted(purchaseProduct),
      ),
      columns: { productId: true },
    }),
  "WishCandidate.productId": (tx, ids) =>
    tx.query.wishCandidate.findMany({
      where: and(
        inArray(wishCandidate.productId, ids),
        notDeleted(wishCandidate),
      ),
      columns: { productId: true },
    }),
  "Location.productId": (tx, ids) =>
    tx.query.location.findMany({
      where: and(inArray(location.productId, ids), notDeleted(location)),
      columns: { productId: true },
    }),
  "Cookbook.productId": (tx, ids) =>
    tx.query.cookbook.findMany({
      where: and(inArray(cookbook.productId, ids), notDeleted(cookbook)),
      columns: { productId: true },
    }),
  "ProductComponent.componentProductId": async (tx, ids) => {
    const rows = await tx.query.productComponent.findMany({
      where: and(
        inArray(productComponent.componentProductId, ids),
        notDeleted(productComponent),
      ),
      columns: { componentProductId: true },
    });
    return rows.map(({ componentProductId }) => ({
      productId: componentProductId,
    }));
  },
};

/**
 * Soft delete products by setting deletedAt timestamp.
 * Also soft deletes related unit mappings and images.
 * Throws if any product has live acquisition evidence or durable work history
 * (inventory, expenses, or tasks — see `PRODUCT_EDGE_ROLES` in
 * `./edge-roles`).
 */
/**
 * Returns the R2 keys of images the cascade reaped, for the caller to drop
 * after this commit — an object delete has no rollback.
 */
export const deleteProducts = async (
  db: Database,
  ids: ProductId[],
  actor: ActorContext,
): Promise<{ detachedImageKeys: string[]; deleted: number }> => {
  if (ids.length === 0) return { detachedImageKeys: [], deleted: 0 };

  return await withTransaction(db, async (tx) => {
    // Lock products and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, product, ids, "Product");

    /** Product deletion must reject live acquisition/history evidence through the shared incoming-edge policy. */
    for (const key of Object.keys(
      PRODUCT_RETAINING_DEPENDENTS,
    ) as Array<ProductRetainingEdgeKey>) {
      // Iterate `PRODUCT_RETAINING_DEPENDENTS`'s own keys — typed
      // `Record<ProductRetainingEdgeKey, ...>` (see ./edge-roles) — rather
      // than every policy entry, so `key` is provably in that type with no
      // cast. Still drive the actual block decision off the delete policy's
      // own `block` effect rather than the role itself: the roles are shared
      // vocabulary, so a negative filter would silently promote any
      // newly-introduced role (e.g. the `media` role `ProductImage.productId`
      // now carries) into a delete blocker. The `PRODUCT_EDGE_ROLES backstop`
      // test in product.integration.test.ts guards the two staying in
      // agreement.
      const disposition = PRODUCT_DELETE_EDGE_POLICY[key];
      if (disposition.effect !== "block") continue;
      const fetchDependents = PRODUCT_RETAINING_DEPENDENTS[key];
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

    await tx
      .delete(productConversionCoverage)
      .where(inArray(productConversionCoverage.productId, ids));

    return await removeEntity(tx, {
      entity: "product",
      ids,
      removal: "soft",
      actor,
      children: [
        {
          table: productUnitMappings,
          parentColumns: [productUnitMappings.productId],
          auditKey: "cascadedUnitMappings",
        },
        {
          table: productExternalId,
          parentColumns: [productExternalId.productId],
          auditKey: "cascadedExternalIds",
        },
        {
          table: productImage,
          parentColumns: [productImage.productId],
          auditKey: "cascadedImages",
        },
        {
          table: productComponent,
          parentColumns: [productComponent.parentProductId],
          auditKey: "cascadedComponents",
        },
      ],
    });
  });
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
