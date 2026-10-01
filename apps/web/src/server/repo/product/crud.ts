import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { EntityLinkKind } from "@cubby/schemas/entity-links";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  displayGtin,
  type ExternalIdKind,
  GTIN_SOURCE,
  storedExternalIdUrl,
} from "@cubby/schemas/external-id";
import type {
  IngredientId,
  PlantId,
  LocationId,
  ProductId,
  ProductCategoryId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import {
  buildTakeSkip,
  type PaginationParams,
  type ListGroupSummary,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  ProductBulkStockTrackedInput,
  ProductFilters,
  ProductPickerItemOut,
} from "@cubby/schemas/product";
import {
  hasFoodIndicators,
  type ProductCreateInput,
  type ProductTopLevelOut,
  type ProductUpdateInput,
} from "@cubby/schemas/product";
import { relatedViewKeySchema } from "@cubby/schemas/related-view";
import { formatCategoryLabel, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
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
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import { z } from "zod";

import { projectListRows } from "~/entities/list-read-schema";
import { startOperationDefinition } from "~/lib/start-operation-observability";
import type { USDAClient } from "~/server/clients/usda";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  device,
  entityAttachment,
  entityExternalId,
  entityLink,
  expense,
  image,
  inventoryEntry,
  location,
  mealFoodEntry,
  photoGroupProposal,
  plant,
  planting,
  product,
  productConversionCoverage,
  productUnitMappings,
  runTarget,
  task,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { observeOperationPhase } from "~/server/observed-request";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  assertNoDependents,
  associatePendingImages,
  countWhere,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  idSetPresence,
  imageJoinBindings,
  insertAndReturn,
  type ListReadIntent,
  lockAndValidateForDelete,
  mapImages,
  notDeleted,
  shortcodeSetCondition,
  presenceCondition,
  rangeConditions,
  relations,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  resolveEntityDisplayImageLists,
  resolveEntityDisplayImages,
} from "~/server/repo/entity-display-image";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import { liveLinks } from "~/server/repo/entity-links";
import { patchEntityRows } from "~/server/repo/entity-patch";
import {
  productAcquisitionDateFilterSql,
  productAcquisitionDateSql,
  productExpenseCountFilterSql,
  productExpenseCountSql,
  productExpenseTotalFilterSql,
  productExpenseTotalSql,
} from "~/server/repo/expense-aggregate-sql";
import { loadImageAnalysisSummaries } from "~/server/repo/image-analysis-summary";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import {
  enrichProductRowsWithInventoryValuations,
  loadInventoryValuations,
} from "~/server/repo/inventory/valuation";
import { resolveEstablishedManufacturer } from "~/server/repo/label-canonical";
import { listScaffold } from "~/server/repo/list";
import {
  loadListGroup,
  wantsListGroup,
  type ListProjection,
} from "~/server/repo/list-projection";
import { loadLocationAncestorsWithIds } from "~/server/repo/location/tree";
import {
  resolveProductCategory,
  loadCategorySummaries,
} from "~/server/repo/product-category";
import {
  categorySummarySql,
  categoryFeatureSql,
} from "~/server/repo/product-category-sql";
import { categoryDescendantsSql } from "~/server/repo/product-category-sql";
import { relatedSortExpression } from "~/server/repo/related-view";
import { deleteByPolicy } from "~/server/repo/removal";
import { createEntityReader } from "~/server/repo/repository";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { effectiveTaskSubjectProductSql } from "~/server/repo/task-project-inheritance";

import { hydrateImageReadProjection } from "../image-read-projection";
import { validateLiveEffectiveTrades } from "../inheritance-validation";
import { assertProductCategoryChange } from "./classification";
import { getProductClassificationEvidence } from "./classification-evidence";
import {
  currentProductConversionCoverageCondition,
  markProductConversionCoverageInputStale,
} from "./conversion-coverage";
import {
  PRODUCT_DELETE_EDGE_POLICY,
  isRetainingEdgeKey,
  type ProductRetainingEdgeKey,
} from "./edge-roles";
import {
  loadPrimaryGtins,
  productHasGtin,
  productMatchesGtinTerm,
} from "./gtin";
import { enrichProductListItems } from "./list-enrichment";
import {
  dbProductToAPI,
  deriveProductQuantitySummary,
  splitProductImages,
  mapProductExternalIds,
  mapProductUnitMappings,
  mapProductListInventoryEntries,
  primaryGtinOf,
  mapDbProductIngredient,
  dbProductToListAPI,
  dbProductToPickerItemAPI,
  dbProductToTopLevelAPI,
  productImageShortcodesOf,
} from "./mappers";
import { ownershipExitExpensePredicate } from "./ownership";
import {
  derivedPriceFilterSql,
  effectiveProductPriceSql,
  enrichProductRowsWithPricing,
  loadEffectiveProductPricesById,
  loadProductPriceSum,
  loadProductPricing,
  resolveProductPricing,
  resolveProductPriceField,
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
import type { ProductDeepDB, ProductListDB } from "./types";
import { unitMappingColumns } from "./unit-mappings";
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
    return [sql`${productExpenseTotalSql()} ${sql.raw(dirSql)}`];
  }

  if (sort.orderBy === "price") {
    return [sql.raw(`${effectiveProductPriceSql()} ${dirSql}`)];
  }

  // `expenses` is the COLUMN id; `expenseCount` is the row field. See the note
  // on the column in app/products/productlist.tsx for why the id is the half
  // that cannot move.
  if (sort.orderBy === "expenseCount") {
    return [sql`${productExpenseCountSql()} ${sql.raw(dirSql)}`];
  }

  if (sort.orderBy === "ledgerExpectedQuantity") {
    return [sql.raw(`${expectedQuantitySql()} ${dirSql}`)];
  }

  if (sort.orderBy === "quantityVariance") {
    return [sql.raw(`${quantityVarianceSql()} ${dirSql}`)];
  }

  if (sort.orderBy === "purchaseDate") {
    // Same fragment the cell renders (relations.ts) and both filters below use.
    return [sql`${productAcquisitionDateSql()} ${sql.raw(dirSql)}`];
  }

  // Every `related:` sort is the related-view registry's own joins, sort
  // expression, and `where` — never a hand copy. See `relatedSortExpression`.
  if (sort.orderBy.startsWith("related:")) {
    const relationKey = sort.orderBy.slice("related:".length);
    const parsedRelationKey = relatedViewKeySchema.safeParse(relationKey);
    if (!parsedRelationKey.success) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Unknown related-view sort ${relationKey}`,
      );
    }
    return [
      sql`${relatedSortExpression(
        parsedRelationKey.data,
        '"product"."id"',
      )} ${sql.raw(dirSql)}`,
    ];
  }

  if (sort.orderBy === "primaryGtin") {
    return [
      sql.raw(
        `(SELECT pei."externalId" FROM "EntityExternalId" pei ` +
          `WHERE pei."entityId" = "product"."id" AND pei."source" = 'gtin' AND pei."deletedAt" IS NULL ` +
          `ORDER BY pei."isPrimary" DESC, pei."createdAt", pei."id" LIMIT 1) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "categoryId")
    return [
      sql`${categorySummarySql(sql`${product.categoryId}`)}::jsonb->'path' ${sql.raw(dirSql)}`,
    ];

  return null;
};

const productScaffold = listScaffold("product", product);

const loadProductDataQualities = (
  db: Database | DrizzleTransaction,
  ids: ProductId[],
) => loadDataQualities(db, "product", ids);

const productListOrderBy = (
  sorts: SortParams[],
  groupBy?: string,
  filters?: ProductFilters,
) =>
  productScaffold.orderBy(
    sorts,
    {
      groupBy,
      resolve: resolveProductSort,
      tieBreaker: sql`${product.name} ASC, ${product.shortcode} ASC`,
    },
    filters,
  );

// Read from the manifest instead of re-hardcoding: `sort.grouping` on
// `00-product.entity.ts` is this entity's one declared list-grouping
// contract, compiler-checked to name a `sort.groupable` field.
const PRODUCT_GROUPING = generatedEntitySort.product.grouping;
if (!PRODUCT_GROUPING)
  throw new Error("product entity declares no list-grouping contract.");

const loadProductCategoryGroups = async (
  db: Database,
  whereClause: SQL | undefined,
  sorts: SortParams[],
) => {
  const counts = await getDb(db)
    .select({
      categoryId: product.categoryId,
      count: sql<number>`count(*)::int`,
    })
    .from(product)
    .where(whereClause)
    .groupBy(product.categoryId);
  const summaries = await loadCategorySummaries(db);
  const direction =
    sorts.find((sort) => sort.orderBy === "categoryId")?.direction ?? "asc";
  const groups: Array<{
    key: string;
    label: string;
    count: number;
    categoryId: ProductCategoryId | null;
  }> = [];
  let unclassifiedCount = 0;
  for (const { categoryId, count } of counts) {
    const category = categoryId ? summaries.get(categoryId) : null;
    if (!category) {
      unclassifiedCount += count;
      continue;
    }
    groups.push({
      key: category.id,
      label: formatCategoryLabel(category),
      count,
      categoryId,
    });
  }
  if (unclassifiedCount > 0)
    groups.push({
      key: PRODUCT_GROUPING.nullGroupKey,
      label: "Unclassified",
      count: unclassifiedCount,
      categoryId: null,
    });
  return groups.sort((a, b) =>
    a.categoryId === null
      ? 1
      : b.categoryId === null
        ? -1
        : (a.label.localeCompare(b.label) || a.key.localeCompare(b.key)) *
          (direction === "desc" ? -1 : 1),
  );
};

const productCategoryGroupOrder = (
  groups: Awaited<ReturnType<typeof loadProductCategoryGroups>>,
): SQL | null =>
  groups.some((group) => group.categoryId !== null)
    ? sql`case ${sql.join(
        groups
          .filter((group) => group.categoryId !== null)
          .map(
            (group, index) =>
              sql`when ${product.categoryId} = ${group.categoryId} then ${index}`,
          ),
        sql` `,
      )} else ${groups.length} end asc`
    : null;

const PRODUCT_DETAIL_OPERATION = startOperationDefinition("entity.detail");

const fetchProductById = async (
  db: Database,
  id: ProductId,
): Promise<ProductDeepDB | undefined> => {
  const row = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "base",
    () =>
      getDb(db).query.product.findFirst({
        where: and(eq(product.id, id), notDeleted(product)),
        ...relations.product.full,
      }),
  );
  if (!row) return undefined;
  const priced = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "pricing",
    async () =>
      enrichProductRowsWithPricing(
        db,
        await enrichProductRowsWithInventoryValuations(db, [row]),
      ),
  );
  const ledgered = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "quantity",
    () => enrichProductRowsWithQuantityLedger(db, priced),
  );
  return (
    await observeOperationPhase(PRODUCT_DETAIL_OPERATION, "breadcrumbs", () =>
      hydrateProductLocationBreadcrumbs(db, ledgered),
    )
  )[0];
};

/** Resolve location breadcrumbs and identity-product covers in batch; preserve both relationship directions. */
export const hydrateProductLocationBreadcrumbs = async (
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
    ]).map((entityId) => ({ entityKind: "location" as const, entityId })),
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
    const [qualities, coverImageUrls, analysisSummaries] = await Promise.all([
      observeOperationPhase(PRODUCT_DETAIL_OPERATION, "quality", () =>
        loadProductDataQualities(db, [row.id]),
      ),
      getProductCoverImageUrlsByProductIds(db, [row.id]),
      loadImageAnalysisSummaries(db, productImageShortcodesOf(row.images)),
    ]);
    return dbProductToAPI(
      { ...row, coverImageUrl: coverImageUrls.get(row.id) ?? null },
      qualities.get(row.id)!,
      analysisSummaries,
    );
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
      productId: entityAttachment.entityId,
      image,
    })
    .from(entityAttachment)
    .innerJoin(image, eq(entityAttachment.imageId, image.id))
    .where(
      and(
        inArray(entityAttachment.entityId, uniqueIds),
        notDeleted(entityAttachment),
        sql`${entityAttachment.purpose} IS DISTINCT FROM 'label'`,
        notDeleted(image),
      ),
    )
    .orderBy(asc(entityAttachment.sortOrder), asc(entityAttachment.createdAt));

  for (const row of rows) {
    const [mapped] = mapImages([row.image]);
    if (mapped) result[row.productId]?.push(mapped);
  }

  return hydrateImageReadProjection(db, result);
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
  const [qualities, coverImageUrls, analysisSummaries] = await Promise.all([
    loadProductDataQualities(
      db,
      results.map((row) => row.id),
    ),
    getProductCoverImageUrlsByProductIds(
      db,
      results.map((row) => row.id),
    ),
    loadImageAnalysisSummaries(
      db,
      results.flatMap((row) => productImageShortcodesOf(row.images)),
    ),
  ]);
  const priced = await enrichProductRowsWithPricing(
    db,
    await enrichProductRowsWithInventoryValuations(db, results),
  );
  const ledgered = await hydrateProductLocationBreadcrumbs(
    db,
    await enrichProductRowsWithQuantityLedger(db, priced),
  );
  return ledgered.map((row) =>
    dbProductToAPI(
      { ...row, coverImageUrl: coverImageUrls.get(row.id) ?? null },
      qualities.get(row.id)!,
      analysisSummaries,
    ),
  );
};

const categoryFilterCondition = async (
  db: Database,
  filters: ProductListFilters,
) =>
  filters.categoryFilter?.length || filters.categoryFeatureFilter?.length
    ? or(
        filters.categoryFilter?.length
          ? sql`${product.categoryId} IN ${categoryDescendantsSql(await resolveAllOrThrow(db, "productCategory", Array.isArray(filters.categoryFilter) ? filters.categoryFilter : [filters.categoryFilter]))}`
          : undefined,
        ...(filters.categoryFeatureFilter
          ? (Array.isArray(filters.categoryFeatureFilter)
              ? filters.categoryFeatureFilter
              : [filters.categoryFeatureFilter]
            ).map((feature) =>
              categoryFeatureSql(sql`${product.categoryId}`, feature),
            )
          : []),
        filters.categoryPresenceFilter === "none"
          ? isNull(product.categoryId)
          : undefined,
      )
    : presenceCondition(product.categoryId, filters.categoryPresenceFilter);

/**
 * The complete WHERE for a product list. `getEntityCounts` calls it with `{}`
 * — see repo/dashboard.ts.
 */
type ProductListFilters = ProductFilters & { ids?: readonly string[] };

export const buildProductWhere = async (
  db: Database,
  filters: ProductListFilters,
) => {
  const dbClient = getDb(db);

  const requestedLocationCodes = filters.locationIdFilter
    ? [filters.locationIdFilter].flat()
    : [];
  const requestedIngredientCodes = filters.ingredientIdFilter
    ? [filters.ingredientIdFilter].flat()
    : [];
  const requestedGrowsPlantCodes = filters.growsPlantIdFilter
    ? [filters.growsPlantIdFilter].flat()
    : [];
  const [selectedLocationIds, selectedIngredientIds, selectedGrowsPlantIds] =
    await Promise.all([
      resolveAllPresent(db, "location", requestedLocationCodes),
      resolveAllPresent(db, "ingredient", requestedIngredientCodes),
      resolveAllPresent(db, "plant", requestedGrowsPlantCodes),
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
    .select({ productId: effectiveTaskSubjectProductSql() })
    .from(task)
    .where(
      and(
        notDeleted(task),
        isNotNull(effectiveTaskSubjectProductSql()),
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

  // Joins Image so this matches what the thumbnail cell actually renders — it
  // drops PDF manuals, and Image is separately soft-deletable from ProductImage.
  const productIdsWithImages = dbClient
    .select({ productId: entityAttachment.entityId })
    .from(entityAttachment)
    .innerJoin(
      image,
      and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
    )
    .where(
      and(
        notDeleted(entityAttachment),
        sql`${entityAttachment.purpose} IS DISTINCT FROM 'label'`,
        displayableImageWhere,
      ),
    );

  const productIdsWithUnitMappings = dbClient
    .select({ productId: productUnitMappings.productId })
    .from(productUnitMappings)
    .where(notDeleted(productUnitMappings));

  // Kit membership requires live parent and component rows; do not approximate liveness with stale joins.
  const partsAccountedKitsSql = (productId: PgColumn) =>
    sql`(SELECT min(floor(COALESCE(${sql.raw(onHandUnitsSql("kac_p"))}, 0) / kac."quantity"))
           FROM "EntityLink" kac
           JOIN "Product" kac_p
             ON kac_p."id" = kac."toEntityId" AND kac_p."deletedAt" IS NULL
          WHERE kac."fromEntityId" = ${productId}
            AND kac."deletedAt" IS NULL AND kac."kind" = 'productComponent')`;

  const productIdsWithComponents = dbClient
    .select({ productId: entityLink.fromEntityId })
    .from(entityLink)
    .where(liveLinks("productComponent"));

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
    .select({ productId: entityExternalId.entityId })
    .from(entityExternalId)
    .where(
      and(
        notDeleted(entityExternalId),
        externalSources && externalSources.length > 0
          ? inArray(entityExternalId.source, externalSources)
          : undefined,
      ),
    );

  const gtinRows = dbClient
    .select({ productId: entityExternalId.entityId })
    .from(entityExternalId)
    .where(
      and(
        notDeleted(entityExternalId),
        eq(entityExternalId.source, GTIN_SOURCE),
      ),
    );
  const productIdsWithGtin = gtinRows;

  // Mirrors `foodLookupParamFromProduct` returning null (no explicit fdc_id AND
  // no barcode to auto-match) OR'd with "no label nutrition override" — a
  // label supersedes the USDA lookup outright, so a labelled product counts as
  // present even with neither key. This is the closest pure-SQL predicate — it
  // cannot know whether the USDA worker resolves a food for that key, which is
  // why the filter is labelled "USDA key". Passed as `presenceCondition`'s
  // `emptyWhen` so "has" is derived as not(this) and the two branches can't
  // drift.
  // The outer parens are load-bearing, same as TAGS_ARE_EMPTY in recipe/crud.ts:
  // `presenceCondition` derives "has" as `not(this)`, and drizzle's `not()`
  // doesn't add its own. Unparenthesized, `NOT a IS NULL AND NOT EXISTS ...`
  // binds as `(NOT a IS NULL) AND (NOT EXISTS ...)` — i.e. "has fdc_id AND has
  // no barcode", which silently drops every barcode-only product from "has".
  const NO_USDA_KEY = sql`(${product.fdc_id} IS NULL AND ${product.labelNutrition} IS NULL AND NOT EXISTS (
    SELECT 1 FROM "EntityExternalId" pei
    WHERE pei."entityId" = ${product.id}
      AND pei."source" = ${GTIN_SOURCE}
      AND pei."deletedAt" IS NULL))`;

  const classificationConditions = () => [
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
    requestedGrowsPlantCodes.length > 0 && selectedGrowsPlantIds.length === 0
      ? sql`false`
      : selectedGrowsPlantIds.length > 0
        ? inArray(product.growsPlantId, selectedGrowsPlantIds)
        : undefined,
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
  ];

  const inventoryConditions = () => [
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
      productExpenseCountFilterSql(product.id),
      filters,
      "expenseCount",
    ),
    ...rangeConditions(
      productExpenseTotalFilterSql(product.id),
      filters,
      "expenseTotal",
    ),
    ...rangeConditions(
      expectedQuantityFilterSql(product.id),
      filters,
      "expectedQuantity",
    ),
    // Variance only means reconciliation when both physical stock and ledger
    // evidence exist. Locations count as on-hand here because the compared SQL
    // projection counts them too.
    filters.quantityVarianceFilter !== undefined
      ? and(
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
  ];

  const ledgerConditions = () => [
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
    // The cell renders acquisition date, not generic Purchase presence; keep
    // this predicate on the exact same derived projection.
    filters.purchaseDatePresenceFilter === "has"
      ? isNotNull(productAcquisitionDateFilterSql(product.id))
      : filters.purchaseDatePresenceFilter === "none"
        ? isNull(productAcquisitionDateFilterSql(product.id))
        : undefined,
    taskFilterActive
      ? inArray(product.id, productIdsWithFilteredTasks)
      : undefined,
    filters.purchaseDateFrom
      ? sql`${productAcquisitionDateFilterSql(product.id)} >= ${filters.purchaseDateFrom}`
      : undefined,
    filters.purchaseDateTo
      ? sql`${productAcquisitionDateFilterSql(product.id)} <= ${filters.purchaseDateTo}`
      : undefined,
  ];

  const associationConditions = () => [
    idSetPresence(
      product.id,
      filters.imagePresenceFilter,
      productIdsWithImages,
    ),
    filters.kitId === undefined
      ? undefined
      : sql`EXISTS (
          SELECT 1
          FROM "EntityLink" kit_pc
          JOIN "Product" kit ON kit."id" = kit_pc."fromEntityId" AND kit."deletedAt" IS NULL
          WHERE kit_pc."toEntityId" = ${product.id}
            AND kit_pc."deletedAt" IS NULL AND kit_pc."kind" = 'productComponent'
            AND ${shortcodeSetCondition(sql`kit."shortcode"`, filters.kitId)})`,
    filters.componentId === undefined
      ? undefined
      : sql`EXISTS (
          SELECT 1
          FROM "EntityLink" component_pc
          JOIN "Product" component ON component."id" = component_pc."toEntityId" AND component."deletedAt" IS NULL
          WHERE component_pc."fromEntityId" = ${product.id}
            AND component_pc."deletedAt" IS NULL AND component_pc."kind" = 'productComponent'
            AND ${shortcodeSetCondition(sql`component."shortcode"`, filters.componentId)})`,
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
    idSetPresence(product.id, filters.upcPresenceFilter, productIdsWithGtin),
    filters.upcFilter ? productMatchesGtinTerm(filters.upcFilter) : undefined,
  ];

  const qualityConditions = () => [
    presenceCondition(product.fdc_id, filters.usdaPresenceFilter, NO_USDA_KEY),
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
  ];

  // name/model/notes/manufacturerFilter (text), category (multiselect +
  // presence), manufacturerExact (multiselect), tags (overlap + presence) and
  // the model/notes/stockTracked presence filters are declared stored
  // filters — applied by `productScaffold.where` before the conditions below.
  const whereClause = productScaffold.where(filters, [
    await categoryFilterCondition(db, filters),
    ...classificationConditions(),
    ...inventoryConditions(),
    ...ledgerConditions(),
    ...associationConditions(),
    ...qualityConditions(),
  ]);
  return whereClause;
};

const loadProductListSums = async (
  db: Database,
  whereClause: SQL | undefined,
) => {
  const [price, expenseRows] = await Promise.all([
    loadProductPriceSum(db, whereClause),
    // Money is the signed Expense sum over the complete filtered product set.
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
  const expenseTotal = Number(expenseRows[0]?.expenseTotalSum ?? 0);
  return {
    price: Number.isNaN(price) ? 0 : price,
    expenseTotal: Number.isNaN(expenseTotal) ? 0 : expenseTotal,
  };
};

export const productListSummary = async (
  db: Database,
  filters: ProductListFilters,
) => loadProductListSums(db, await buildProductWhere(db, filters));

type ProductSelectedPageRow = typeof product.$inferSelect &
  Partial<
    Pick<
      ProductListDB,
      | "category"
      | "classificationEvidence"
      | "ingredient"
      | "growsPlant"
      | "expenseCount"
      | "componentCount"
      | "expenseTotal"
      | "purchaseDate"
    >
  >;

/** The authoritative filtered, sorted page is shared by every projection. */
const readProductListPage = async (
  db: Database,
  whereClause: SQL | undefined,
  filters: ProductListFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy: string | undefined,
  readIntent: ListReadIntent,
  projection: ListProjection,
) => {
  const groups =
    groupBy === PRODUCT_GROUPING.field && readIntent === "page"
      ? await loadProductCategoryGroups(db, whereClause, sorts)
      : null;
  const groupOrder = groups ? productCategoryGroupOrder(groups) : null;
  const orderByArray = [
    ...(groupOrder ? [groupOrder] : []),
    ...productListOrderBy(
      sorts,
      groupBy === PRODUCT_GROUPING.field ? undefined : groupBy,
      filters,
    ),
  ];
  const { take, skip } = productScaffold.page(pagination);
  const relationFields = wantsListGroup(projection, "relations");
  const derivedFields = wantsListGroup(projection, "derived");
  const extras = relations.product.listBase.extras;
  type ProductListExtras = {
    -readonly [K in keyof typeof extras]?: (typeof extras)[K];
  };
  const selectedExtras: ProductListExtras = {};
  if (relationFields) selectedExtras.category = extras.category;
  if (wantsListGroup(projection, "quality"))
    selectedExtras.classificationEvidence = extras.classificationEvidence;
  if (derivedFields)
    Object.assign(selectedExtras, {
      expenseCount: extras.expenseCount,
      componentCount: extras.componentCount,
      expenseTotal: extras.expenseTotal,
      purchaseDate: extras.purchaseDate,
    });
  const page = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      getDb(db).query.product.findMany({
        where: whereClause,
        orderBy: orderByArray,
        limit: take,
        offset: skip,
        with: relationFields ? relations.product.listBase.with : undefined,
        extras: selectedExtras,
      }),
    count: () => countWhere(db, product, whereClause),
  });
  // SAFETY: SQL extras use the same contracts as ProductListDB. The projection
  // gates select optional extras and joins, which Drizzle loses when `with`
  // is conditional; stored Product columns are always selected.
  const results = page.data as ProductSelectedPageRow[];
  return { results, totalCount: page.count, groups };
};

export const productList = async (
  db: Database,
  filters: ProductListFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
  readIntent: ListReadIntent = "page",
  usdaClient?: Pick<USDAClient, "findFoodsBatch">,
) => {
  const whereClause = await buildProductWhere(db, filters);
  if (readIntent === "count")
    return {
      data: [],
      count: await countWhere(db, product, whereClause),
      sums: undefined,
      groups: undefined,
    };
  const [{ results, totalCount, groups }, sums] = await Promise.all([
    readProductListPage(
      db,
      whereClause,
      filters,
      sorts,
      pagination,
      groupBy,
      readIntent,
      { kind: "full" },
    ),
    readIntent === "page" ? loadProductListSums(db, whereClause) : undefined,
  ]);
  const ids = results.map((row) => row.id);
  const [listRelations, qualities, priced, ledgered, displayImages] =
    await Promise.all([
      loadProductListRelations(db, ids),
      loadProductDataQualities(db, ids),
      enrichProductRowsWithPricing(db, results),
      enrichProductRowsWithQuantityLedger(db, results),
      resolveEntityDisplayImageLists(
        db,
        ids.map((id) => ({ entityKind: "product", entityId: id })),
      ),
    ]);
  const pricingById = new Map(priced.map((row) => [row.id, row.pricing]));
  const ledgerById = new Map(
    ledgered.map((row) => [row.id, row.quantityLedger]),
  );
  // SAFETY: the full page selects every ProductListDB extra and join; all
  // required batched relations, quality, pricing and ledger values below
  // are attached before the canonical mapper runs.
  const products = await hydrateImageReadProjection(
    db,
    results.map((row) =>
      dbProductToListAPI(
        {
          ...row,
          ...(listRelations.get(row.id) ?? emptyProductListRelations()),
          pricing: pricingById.get(row.id)!,
          quantityLedger: ledgerById.get(row.id)!,
          dataQuality: qualities.get(row.id)!,
        } as ProductListDB,
        displayImages.get(entityRefKey("product", row.id)) ?? [],
      ),
    ),
    new Map(
      [...displayImages.values()].flatMap((images) =>
        images.flatMap((image) =>
          image.representations
            ? [[image.id, image.representations] as const]
            : [],
        ),
      ),
    ),
  );
  const productsWithUnitPrices = await enrichProductListItems(
    products,
    usdaClient,
  );

  const result = {
    data: productsWithUnitPrices,
    count: totalCount,
    sums,
    groups: undefined,
  };
  return groups
    ? {
        ...result,
        groups: groups.map(({ key, label, count }) => ({ key, label, count })),
      }
    : result;
};

type ProductListReadResult = {
  data: ReturnType<typeof projectListRows>;
  count: number;
  groups?: ListGroupSummary[];
};

/** Deferred reads emit canonical patches, never placeholder full records. */
export const listProductsRead = async (
  db: Database,
  filters: ProductListFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
  readIntent: ListReadIntent = "page",
  usdaClient?: Pick<USDAClient, "findFoodsBatch">,
  projection: ListProjection = { kind: "full" },
): Promise<ProductListReadResult> => {
  if (projection.kind === "full") {
    const { data, count, groups } = await productList(
      db,
      filters,
      sorts,
      pagination,
      groupBy,
      readIntent,
      usdaClient,
    );
    const result: ProductListReadResult = { data, count };
    if (groups) result.groups = groups;
    return result;
  }
  const whereClause = await buildProductWhere(db, filters);
  const { results, totalCount, groups } = await readProductListPage(
    db,
    whereClause,
    filters,
    sorts,
    pagination,
    groupBy,
    readIntent,
    projection,
  );
  const rows = results.map(
    ({
      categoryId: _categoryId,
      ingredientId: _ingredientId,
      growsPlantId: _growsPlantId,
      ...row
    }) => ({
      ...row,
      id: parseShortcodeFor("product", row.shortcode),
      modelPresence: Boolean(row.model),
      notesPresence: Boolean(row.notes),
    }),
  );
  const metadata: Pick<ProductListReadResult, "count" | "groups"> = {
    count: totalCount,
  };
  if (groups)
    metadata.groups = groups.map(({ key, label, count }) => ({
      key,
      label,
      count,
    }));
  if (projection.kind === "base" || results.length === 0)
    return { ...metadata, data: projectListRows("product", rows, projection) };
  const ids = results.map((row) => row.id);
  const [listRelations, qualities, priced, ledgered, displayImages] =
    await Promise.all([
      loadProductListRelations(db, ids, projection),
      loadListGroup(projection, "quality", () =>
        loadProductDataQualities(db, ids),
      ),
      loadListGroup(projection, "derived", () =>
        enrichProductRowsWithPricing(db, results),
      ),
      loadListGroup(projection, "derived", () =>
        enrichProductRowsWithQuantityLedger(db, results),
      ),
      loadListGroup(projection, "media", () =>
        resolveEntityDisplayImageLists(
          db,
          ids.map((entityId) => ({ entityKind: "product", entityId })),
        ),
      ),
    ]);
  const pricingById = new Map(priced?.map((row) => [row.id, row.pricing]));
  const ledgerById = new Map(
    ledgered?.map((row) => [row.id, row.quantityLedger]),
  );
  const deferredRows: ReturnType<typeof projectListRows> = results.map(
    (row, index) => {
      const relations =
        listRelations.get(row.id) ?? emptyProductListRelations();
      const ingredient = row.ingredient;
      const inventory = mapProductListInventoryEntries(
        relations.inventoryEntry,
      );
      const patch = { ...rows[index] };
      if (qualities)
        Object.assign(patch, {
          dataQuality: qualities.get(row.id),
          dataGaps: qualities.get(row.id)?.gaps.map((gap) => gap.check),
        });
      if (wantsListGroup(projection, "media")) {
        const { itemImages, ...imageGroups } = splitProductImages(
          relations.images,
        );
        Object.assign(patch, {
          ...imageGroups,
          images: itemImages,
          displayImages:
            displayImages?.get(entityRefKey("product", row.id)) ?? [],
        });
      }
      if (wantsListGroup(projection, "relations"))
        Object.assign(patch, {
          category: row.category,
          categoryId: row.category?.id ?? null,
          growsPlantId: row.growsPlant
            ? parseShortcodeFor("plant", row.growsPlant.shortcode)
            : null,
          ingredient:
            ingredient && ingredient.deletedAt === null
              ? mapDbProductIngredient(ingredient)
              : null,
          inventoryEntry: inventory,
          externalIds: mapProductExternalIds(relations.externalIds),
          unitMappings: mapProductUnitMappings(
            parseShortcodeFor("product", row.shortcode),
            relations.unitMappings,
          ),
          primaryGtin: primaryGtinOf(relations.externalIds),
          upcPresence: Boolean(primaryGtinOf(relations.externalIds)),
        });
      if (wantsListGroup(projection, "derived"))
        Object.assign(patch, {
          pricing: pricingById.get(row.id),
          fieldResolutions: {
            price: resolveProductPriceField(
              row.price,
              pricingById.get(row.id) ?? resolveProductPricing(row.price),
            ),
          },
          expenseCount: Number(row.expenseCount),
          expenseTotal: Number(row.expenseTotal),
          componentCount: Number(row.componentCount),
          purchaseDate: row.purchaseDate,
          ...deriveProductQuantitySummary(inventory, ledgerById.get(row.id)!),
        });
      return patch;
    },
  );
  if (wantsListGroup(projection, "derived")) {
    const seeds = results.map((row) => ({
      id: parseShortcodeFor("product", row.shortcode),
      primaryGtin: primaryGtinOf(listRelations.get(row.id)?.externalIds),
      fdc_id: row.fdc_id,
      price: row.price,
      pricing: pricingById.get(row.id)!,
      labelNutrition: row.labelNutrition,
      unitMappings: mapProductUnitMappings(
        parseShortcodeFor("product", row.shortcode),
        listRelations.get(row.id)?.unitMappings ?? [],
      ),
    }));
    const derived = await enrichProductListItems(seeds, usdaClient);
    derived.forEach((values, index) =>
      Object.assign(deferredRows[index]!, values),
    );
  }
  const hydrated = wantsListGroup(projection, "media")
    ? await hydrateImageReadProjection(
        db,
        deferredRows,
        new Map(
          [...(displayImages?.values() ?? [])].flatMap((images) =>
            images.flatMap((image) =>
              image.representations
                ? [[image.id, image.representations] as const]
                : [],
            ),
          ),
        ),
      )
    : deferredRows;
  return {
    ...metadata,
    data: projectListRows("product", hydrated, projection),
  };
};

type ProductListRelations = Pick<
  ProductListDB,
  "images" | "externalIds" | "unitMappings" | "inventoryEntry"
>;

const emptyProductListRelations = (): ProductListRelations => ({
  images: [],
  externalIds: [],
  unitMappings: [],
  inventoryEntry: [],
});

/**
 * Hydrate Product-list to-many fields in independent batch reads. Drizzle's
 * relational list query is excellent for a single detail graph, but combining
 * four fan-outs with scalar aggregates for 100 products creates a large nested
 * JSON plan that can exceed the small production compute's memory before the
 * rows reach TypeScript.
 */
const loadProductListRelations = async (
  db: Database,
  ids: readonly ProductId[],
  projection: ListProjection = { kind: "full" },
): Promise<Map<ProductId, ProductListRelations>> => {
  const uniqueIds = uniq([...ids]);
  const result = new Map<ProductId, ProductListRelations>(
    uniqueIds.map((id) => [id, emptyProductListRelations()]),
  );
  if (uniqueIds.length === 0) return result;

  const [images, externalIds, unitMappings, inventoryEntries] =
    await Promise.all([
      loadListGroup(projection, "media", () =>
        getDb(db).query.entityAttachment.findMany({
          where: and(
            inArray(entityAttachment.entityId, uniqueIds),
            notDeleted(entityAttachment),
          ),
          orderBy: [
            asc(entityAttachment.sortOrder),
            asc(entityAttachment.createdAt),
          ],
          with: { image: true },
        }),
      ),
      loadListGroup(projection, ["relations", "derived"], () =>
        getDb(db).query.entityExternalId.findMany({
          where: and(
            inArray(entityExternalId.entityId, uniqueIds),
            notDeleted(entityExternalId),
          ),
        }),
      ),
      loadListGroup(projection, ["relations", "derived"], () =>
        getDb(db).query.productUnitMappings.findMany({
          where: and(
            inArray(productUnitMappings.productId, uniqueIds),
            notDeleted(productUnitMappings),
          ),
        }),
      ),
      loadListGroup(projection, ["relations", "derived"], () =>
        getDb(db).query.inventoryEntry.findMany({
          where: and(
            inArray(inventoryEntry.productId, uniqueIds),
            notDeleted(inventoryEntry),
          ),
          orderBy: inventoryEntry.createdAt,
          with: { location: true },
        }),
      ),
    ]);

  for (const row of images ?? []) {
    result.get(parseEntityId("product", row.entityId))?.images.push(row);
  }
  for (const row of externalIds ?? []) {
    result.get(parseEntityId("product", row.entityId))?.externalIds.push(row);
  }
  for (const row of unitMappings ?? []) {
    result.get(row.productId)?.unitMappings.push(row);
  }
  const valuations = await loadInventoryValuations(db, inventoryEntries ?? []);
  for (const row of inventoryEntries ?? []) {
    result.get(row.productId)?.inventoryEntry.push({
      ...row,
      valuation: valuations.get(row.id) ?? null,
    });
  }

  return result;
};

/**
 * A product's cover URL for a batch of picker or relationship rows: `[0]` of
 * the shared display-image policy (`resolveEntityDisplayImages`), so a picker
 * row, a list thumbnail and a search hit can never disagree about which photo
 * is the cover. Full image projections still use `getProductImagesByProductIds`.
 */
export const getProductCoverImageUrlsByProductIds = async (
  db: Database,
  ids: ProductId[],
): Promise<Map<ProductId, string>> => {
  const covers = await resolveEntityDisplayImages(
    db,
    ids.map((entityId) => ({ entityKind: "product", entityId })),
  );
  return new Map(
    ids.flatMap((id) => {
      const cover = covers.get(entityRefKey("product", id));
      return cover ? [[id, preferredImageUrl(cover)]] : [];
    }),
  );
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
    | "nameFilter"
    | "manufacturerFilter"
    | "upcFilter"
    | "categoryFilter"
    | "categoryFeatureFilter"
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
    filters.categoryFeatureFilter?.length
      ? or(
          ...(Array.isArray(filters.categoryFeatureFilter)
            ? filters.categoryFeatureFilter
            : [filters.categoryFeatureFilter]
          ).map((feature) =>
            categoryFeatureSql(sql`${product.categoryId}`, feature),
          ),
        )
      : undefined,
    formatSearchTerm(product.manufacturer, filters.manufacturerFilter),
    filters.upcFilter ? productMatchesGtinTerm(filters.upcFilter) : undefined,
    filters.categoryFilter?.length
      ? sql`${product.categoryId} IN ${categoryDescendantsSql(await resolveAllOrThrow(db, "productCategory", Array.isArray(filters.categoryFilter) ? filters.categoryFilter : [filters.categoryFilter]))}`
      : undefined,
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

  const categories = await loadCategorySummaries(db);
  const resultIds = results.map((result) => result.id);
  const [quantities, coverImageUrls, prices] = await Promise.all([
    loadProductPickerQuantities(db, resultIds),
    getProductCoverImageUrlsByProductIds(db, resultIds),
    loadEffectiveProductPricesById(db, resultIds),
  ]);
  const data = results.map((result) =>
    dbProductToPickerItemAPI({
      ...result,
      category: categories.get(result.categoryId!) ?? null,
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
      categoryId: true,
    },
  });
  const categories = await loadCategorySummaries(db);
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
        category: categories.get(row.categoryId!) ?? null,
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
const databaseErrorNodeSchema = z
  .object({
    code: z.string().optional(),
    constraint: z.string().optional(),
    detail: z.string().optional(),
    cause: z
      .union([z.instanceof(Error), z.object({}).passthrough()])
      .optional(),
  })
  .passthrough();

function findUniqueViolation<TError>(
  error: TError,
  depth = 0,
): { constraint: string; detail: string } | null {
  if (depth >= 6) return null;
  const parsedError = databaseErrorNodeSchema.safeParse(error);
  if (!parsedError.success) return null;

  const current = parsedError.data;
  if (current.code === "23505") {
    return {
      constraint: current.constraint ?? "",
      detail: current.detail ?? "",
    };
  }
  return current.cause === undefined
    ? null
    : findUniqueViolation(current.cause, depth + 1);
}

/**
 * Translate a Product unique-constraint violation into a clear, actionable
 * CONFLICT error (naming the conflicting product/ingredient where possible).
 * No-op if the error isn't a unique violation, so callers can rethrow.
 */
async function throwIfDuplicateProduct<TError>(
  db: Database,
  data: Pick<ProductCreateInput, "name" | "manufacturer"> & {
    upc?: string | null;
  },
  error: TError,
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
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      externalId: entityExternalId.externalId,
    })
    .from(entityExternalId)
    .innerJoin(
      product,
      and(eq(product.id, entityExternalId.entityId), notDeleted(product)),
    )
    .where(
      and(
        notDeleted(entityExternalId),
        exceptProductId
          ? sql`${entityExternalId.entityId} <> ${exceptProductId}`
          : undefined,
        or(
          ...entries.map((entry) =>
            and(
              eq(entityExternalId.source, entry.source),
              eq(entityExternalId.kind, entry.kind),
              eq(entityExternalId.externalId, entry.externalId),
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

/**
 * The reads `createProduct` performs inside its own transaction after the
 * insert. A real port rather than a module seam so a test can make one fail
 * and prove the insert rolls back with it.
 */
export type ProductCreateReads = {
  loadProductDataQualities: typeof loadProductDataQualities;
};
const defaultProductCreateReads: ProductCreateReads = {
  loadProductDataQualities,
};

export const createProduct = async (
  db: Database,
  data: ProductRepoCreateInput,
  actor: ActorContext,
  reads: ProductCreateReads = defaultProductCreateReads,
): Promise<ProductTopLevelOut> => {
  const {
    ingredientId,
    unitMappings,
    externalIds,
    pendingImageIds,
    pendingImagePurposes,
    ...productData
  } = data;

  // Per-each price is the scalar `productData.price` column; a canonical
  // "1 each = $X" mapping would duplicate it (per-measure money mappings are OK).
  if (unitMappings) assertNoCanonicalPriceMapping(unitMappings);

  // Use a transaction to ensure atomicity. On a unique violation (e.g. another
  // product already claims this barcode), translate the raw DB error into a
  // clear CONFLICT message — the duplicate lookups in the catch run on `db`
  // because the tx is aborted by then.
  //
  // The data-quality read stays INSIDE the tx (as `updateProduct` does): run
  // after commit, a failure there threw from a create whose row already
  // existed, so the caller saw "failed" and re-created it. In-tx, that read
  // failing rolls the insert back and "failed" means failed.
  try {
    return await withTransaction(db, async (tx) => {
      // A bare `upc` becomes a `gtin` identifier row rather than a column, and
      // is folded into the payload so it cannot be lost to (or lose to) an
      // explicit `externalIds` on the same call.
      const { upc, isbn, ...columnData } = productData;
      const incomingGtin = resolvePrimaryProductCodeInput({ upc, isbn });
      const desiredExternalIds =
        incomingGtin === undefined || incomingGtin === null
          ? (externalIds ?? [])
          : foldGtinIntoExternalIds(externalIds ?? [], incomingGtin);
      const categoryId = await resolveProductCategory(
        tx,
        data.categoryId ?? null,
        hasFoodIndicators({ ...data, ingredientId })
          ? "food"
          : externalIdsContainIsbn(desiredExternalIds)
            ? "books"
            : null,
      );
      await assertExternalIdsAvailable(tx, desiredExternalIds);
      const newProduct = await insertWithShortcode(tx, "product", {
        ...columnData,
        manufacturer: await resolveEstablishedManufacturer(
          tx,
          productData.manufacturer,
        ),
        categoryId,
        ingredientId: ingredientId ?? null,
      });

      if (unitMappings && unitMappings.length > 0) {
        await tx.insert(productUnitMappings).values(
          unitMappings.map((mapping) => ({
            productId: newProduct.id,
            ...unitMappingColumns(mapping),
            source: mapping.source,
          })),
        );
      }

      if (desiredExternalIds.length > 0) {
        await ensureExternalSources(
          tx,
          desiredExternalIds.map((eid) => eid.source.trim().toLowerCase()),
        );
        await tx.insert(entityExternalId).values(
          desiredExternalIds.map((eid) => ({
            entityId: newProduct.id,
            entityKind: "product" as const,
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
          imageJoinBindings.product,
          newProduct.id,
          resolvedImageIds,
        );
        if (pendingImagePurposes) {
          const resolvedByCode = await resolveLiveShortcodes(
            tx,
            pendingImageIds,
            "image",
          );
          for (const [shortcode, purpose] of Object.entries(
            pendingImagePurposes,
          )) {
            const imageId = resolvedByCode.get(shortcode);
            if (!imageId) continue;
            await tx
              .update(entityAttachment)
              .set({ purpose })
              .where(
                and(
                  eq(entityAttachment.entityId, newProduct.id),
                  eq(entityAttachment.imageId, imageId),
                  notDeleted(entityAttachment),
                ),
              );
          }
        }

        images = await tx
          .select()
          .from(image)
          .where(inArray(image.id, resolvedImageIds));
      }

      await logAuditEntry(tx, actor, {
        entityKind: "product",
        entityId: newProduct.id,
        action: "create",
      });

      const createdExternalIds =
        desiredExternalIds.length > 0
          ? await tx.query.entityExternalId.findMany({
              where: eq(entityExternalId.entityId, newProduct.id),
            })
          : [];

      const growsPlant = productData.growsPlantId
        ? await tx.query.plant.findFirst({
            where: and(
              eq(plant.id, productData.growsPlantId),
              notDeleted(plant),
            ),
            columns: { shortcode: true },
          })
        : null;

      const created = {
        ...newProduct,
        growsPlant,
        images,
        externalIds: createdExternalIds,
      };
      const qualities = await reads.loadProductDataQualities(tx, [created.id]);
      return dbProductToTopLevelAPI({
        classificationEvidence: await getProductClassificationEvidence(
          tx,
          newProduct.id,
        ),
        category:
          (await loadCategorySummaries(tx)).get(newProduct.categoryId!) ?? null,
        ...created,
        pricing: resolveProductPricing(created.price),
        dataQuality: qualities.get(created.id)!,
      });
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
    pendingImagePurposes,
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

  const prepareUpdate = async (
    tx: DrizzleTransaction,
    beforeProduct: typeof product.$inferSelect,
    beforeExternalIds: Array<typeof entityExternalId.$inferSelect>,
  ) => {
    if (unitMappings !== undefined) assertNoCanonicalPriceMapping(unitMappings);
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
    const updateData: Partial<typeof product.$inferInsert> = { ...columnData };
    if (ingredientId !== undefined) updateData.ingredientId = ingredientId;
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
    if (
      hasFoodIndicators({
        fdc_id:
          updateData.fdc_id === undefined
            ? beforeProduct.fdc_id
            : updateData.fdc_id,
        ingredientId:
          updateData.ingredientId === undefined
            ? beforeProduct.ingredientId
            : updateData.ingredientId,
      })
    ) {
      updateData.categoryId = await resolveProductCategory(
        tx,
        updateData.categoryId === undefined
          ? beforeProduct.categoryId
          : updateData.categoryId,
        "food",
      );
    } else if (externalIdsContainIsbn(resultingExternalIds)) {
      updateData.categoryId = await resolveProductCategory(
        tx,
        updateData.categoryId === undefined
          ? beforeProduct.categoryId
          : updateData.categoryId,
        "books",
      );
    }
    return { desiredExternalIds, incomingGtin, updateData };
  };

  const syncProductUpdateDependents = async (
    tx: DrizzleTransaction,
    incomingGtin: string | null | undefined,
    desiredExternalIds: Awaited<
      ReturnType<typeof prepareUpdate>
    >["desiredExternalIds"],
  ) => {
    if (unitMappings !== undefined) {
      await syncProductUnitMappings(tx, id, unitMappings);
    }
    if (
      unitMappings !== undefined ||
      data.price !== undefined ||
      ingredientId !== undefined ||
      data.fdc_id !== undefined ||
      incomingGtin !== undefined ||
      data.labelNutrition !== undefined
    ) {
      await markProductConversionCoverageInputStale(tx, [id]);
    }
    if (externalIds !== undefined) {
      const desired = desiredExternalIds ?? [];
      await assertExternalIdsAvailable(tx, desired, id);
      await syncProductExternalIds(tx, id, desired);
    } else if (incomingGtin !== undefined) {
      await syncPrimaryGtin(tx, id, incomingGtin);
    }
  };

  try {
    const updatedProduct = await withTransaction(db, async (tx) => {
      const beforeProduct = await tx.query.product.findFirst({
        where: and(eq(product.id, id), notDeleted(product)),
      });

      if (!beforeProduct) {
        throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
      }

      const beforeExternalIds = await tx.query.entityExternalId.findMany({
        where: and(
          eq(entityExternalId.entityId, id),
          notDeleted(entityExternalId),
        ),
      });

      const { desiredExternalIds, incomingGtin, updateData } =
        await prepareUpdate(tx, beforeProduct, beforeExternalIds);

      // A caller that only touches a child table — unitMappings, externalIds,
      // pendingImageIds/removeImageIds/imageOrder — leaves no `product` column
      // to set (they're all destructured out of `productData` above). Drizzle's
      // own `.set()` filters out `undefined`-valued entries (mapUpdateSet)
      // before checking for emptiness, so a caller-layer spread that always
      // stamps `growsPlantId: undefined` onto every update (see
      // `updateProductWithFood`) still counts as "nothing to set" here — match
      // that same filter, or `.update(product).set({})` throws "No values to
      // set" rather than no-op-ing. Skip the column update entirely and reuse
      // the row this same transaction already read; nothing else can have
      // changed it since.
      const hasScalarChanges = Object.values(updateData).some(
        (value) => value !== undefined,
      );
      const updated = hasScalarChanges
        ? await updateLiveAndReturn(tx, product, updateData, id)
        : beforeProduct;

      if (updated.categoryId !== beforeProduct.categoryId)
        await validateLiveEffectiveTrades(tx);

      // Conversion coverage and inventory valuation are invalidated only after
      // mappings land; both are projections of the resulting conversion graph.
      await syncProductUpdateDependents(tx, incomingGtin, desiredExternalIds);
      const admittedCategoryId = await assertProductCategoryChange(
        tx,
        id,
        updated.categoryId,
      );
      if (admittedCategoryId !== updated.categoryId)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Product classification conflicts with its identity evidence.",
        );
      detachedImageKeys = await syncProductImages(
        tx,
        id,
        pendingImageIds,
        pendingImagePurposes,
        removeImageIds,
        imageOrder,
      );

      // Fetch all associated images (live only — just-removed ones must not
      // reappear in the response) in display order.
      const productImages = await tx.query.entityAttachment.findMany({
        where: and(
          eq(entityAttachment.entityId, updated.id),
          notDeleted(entityAttachment),
        ),
        with: {
          image: true,
        },
        orderBy: [
          asc(entityAttachment.sortOrder),
          asc(entityAttachment.createdAt),
        ],
      });

      const currentExternalIdRows = await tx.query.entityExternalId.findMany({
        where: and(
          eq(entityExternalId.entityId, updated.id),
          notDeleted(entityExternalId),
        ),
      });

      const changes = computeChanges(
        { ...beforeProduct, externalIds: beforeExternalIds },
        { ...updated, externalIds: currentExternalIdRows },
        [...entityFieldModels.product.audit],
      );

      if (changes) {
        await logAuditEntry(tx, actor, {
          entityKind: "product",
          entityId: updated.id,
          action: "update",
          changes,
        });
      }

      const pricing = await loadProductPricing(tx, [updated]);
      const qualities = await loadProductDataQualities(tx, [updated.id]);
      return dbProductToTopLevelAPI({
        classificationEvidence: await getProductClassificationEvidence(
          tx,
          updated.id,
        ),
        category:
          (await loadCategorySummaries(tx)).get(updated.categoryId!) ?? null,
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
    const ids = await resolveAllOrThrow(tx, "product", input.ids);
    await patchEntityRows(
      tx,
      actor,
      {
        entity: "product",
        table: product,
        fields: entityFieldModels.product.bulk,
      },
      ids,
      { stockTracked },
    );

    // Return every resolved selection, including rows whose value was already
    // equal to the requested flag. The public bulk contract reports the
    // selected rows, while patchEntityRows intentionally returns only changed
    // rows for generic scalar callers.
    return input.ids;
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
    const beforeIds = await tx.query.entityExternalId.findMany({
      where: and(
        eq(entityExternalId.entityId, id),
        notDeleted(entityExternalId),
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
    await ensureExternalSources(
      tx,
      input.upsert.map((entry) => entry.source.trim().toLowerCase()),
    );

    // Slots this call is explicitly removing must never be short-circuited by
    // the unchanged-value check below, even if their pre-removal value
    // happens to match an incoming upsert for the same slot.
    const removedSlots = new Set(
      input.remove.map((r) => `${r.source.trim().toLowerCase()}\0${r.kind}`),
    );

    for (const entry of input.remove) {
      const source = entry.source.trim().toLowerCase();
      await tx
        .update(entityExternalId)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(entityExternalId.entityId, id),
            eq(entityExternalId.source, source),
            eq(entityExternalId.kind, entry.kind),
            eq(entityExternalId.externalId, entry.expectedExternalId),
            notDeleted(entityExternalId),
          ),
        );
    }
    for (const entry of input.upsert) {
      const source = entry.source.trim().toLowerCase();
      const isPrimary = entry.isPrimary ?? true;
      const slotRows = await tx.query.entityExternalId.findMany({
        where: and(
          eq(entityExternalId.entityId, id),
          eq(entityExternalId.source, source),
          eq(entityExternalId.kind, entry.kind),
          notDeleted(entityExternalId),
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
            .update(entityExternalId)
            .set({
              url: storedExternalIdUrl({ ...entry, source }),
              isPrimary: false,
              updatedAt: new Date(),
            })
            .where(eq(entityExternalId.id, liveSlot.id));
        } else {
          await tx.insert(entityExternalId).values({
            entityId: id,
            entityKind: "product" as const,
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
        .insert(entityExternalId)
        .values({
          entityId: id,
          entityKind: "product" as const,
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
            entityExternalId.entityId,
            entityExternalId.source,
            entityExternalId.kind,
          ],
          targetWhere: sql`${entityExternalId.isPrimary} AND ${entityExternalId.deletedAt} IS NULL`,
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

    const externalIds = await tx.query.entityExternalId.findMany({
      where: and(
        eq(entityExternalId.entityId, id),
        notDeleted(entityExternalId),
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
        entityKind: "product",
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
      classificationEvidence: await getProductClassificationEvidence(
        tx,
        before.id,
      ),
      category:
        (await loadCategorySummaries(tx)).get(before.categoryId!) ?? null,
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
    categoryId?: ProductCategoryId | null;
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
  const categoryId = await resolveProductCategory(
    db,
    data.categoryId ?? null,
    hasFoodIndicators(data)
      ? "food"
      : incomingGtin != null &&
          externalIdsContainIsbn([
            { source: GTIN_SOURCE, externalId: incomingGtin },
          ])
        ? "books"
        : null,
  );

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
    categoryId,
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
      entityKind: "product",
      entityId: inserted.id,
      action: "create",
    });

    const rows =
      incomingGtin == null
        ? []
        : await tx.query.entityExternalId.findMany({
            where: eq(entityExternalId.entityId, inserted.id),
          });
    return { newProduct: inserted, externalIds: rows };
  });

  const qualities = await loadProductDataQualities(db, [newProduct.id]);
  return dbProductToTopLevelAPI({
    classificationEvidence: await getProductClassificationEvidence(
      db,
      newProduct.id,
    ),
    category:
      (await loadCategorySummaries(db)).get(newProduct.categoryId!) ?? null,
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
type ProductDependentFetcher = (
  tx: DrizzleClient | DrizzleTransaction,
  ids: ProductId[],
) => Promise<Array<{ productId: ProductId | null }>>;

/** Live links of `kind` whose `to` end is one of the products. */
const liveLinksToProducts =
  (kind: EntityLinkKind): ProductDependentFetcher =>
  async (tx, ids) =>
    (
      await tx
        .select({ productId: entityLink.toEntityId })
        .from(entityLink)
        .where(and(inArray(entityLink.toEntityId, ids), liveLinks(kind)))
    ).map((row) => ({ productId: parseEntityId("product", row.productId) }));

const PRODUCT_RETAINING_DEPENDENTS = {
  "RunTarget.entityId": async (tx, ids) => {
    const rows = await tx.query.runTarget.findMany({
      where: inArray(runTarget.entityId, ids),
      columns: { entityId: true },
    });
    return rows.map(({ entityId }) => ({
      productId: parseEntityId("product", entityId),
    }));
  },
  "Planting.sourceProductId": async (tx, ids) => {
    const rows = await tx.query.planting.findMany({
      where: and(inArray(planting.sourceProductId, ids), notDeleted(planting)),
      columns: { sourceProductId: true },
    });
    return rows.map(({ sourceProductId }) => ({ productId: sourceProductId }));
  },
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
  "EntityLink[projectTool].to": liveLinksToProducts("projectTool"),
  "EntityLink[purchaseProduct].to": liveLinksToProducts("purchaseProduct"),
  "MealFoodEntry.productId": (tx, ids) =>
    tx.query.mealFoodEntry.findMany({
      where: and(
        inArray(mealFoodEntry.productId, ids),
        notDeleted(mealFoodEntry),
      ),
      columns: { productId: true },
    }),
  "EntityLink[wishCandidate].to": liveLinksToProducts("wishCandidate"),
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
  "EntityLink[productComponent].to": liveLinksToProducts("productComponent"),
  // Never read: `Device.productId`'s disposition is "detach", not "block",
  // so the loop below skips it before calling this. Present only to satisfy
  // this map's exhaustiveness over every retaining edge.
  "Device.productId": (tx, ids) =>
    tx.query.device.findMany({
      where: and(inArray(device.productId, ids), notDeleted(device)),
      columns: { productId: true },
    }),
  // Never read either: a "detach" disposition, cleared below.
  "PhotoGroupProposal.productId": (tx, ids) =>
    tx
      .select({ productId: photoGroupProposal.productId })
      .from(photoGroupProposal)
      .where(inArray(photoGroupProposal.productId, ids))
      .then((rows) =>
        rows.flatMap((row) =>
          row.productId ? [{ productId: row.productId }] : [],
        ),
      ),
} satisfies Record<ProductRetainingEdgeKey, ProductDependentFetcher>;

/**
 * Each block edge's guard is its retaining-dependent fetcher (see
 * `./edge-roles`): some count liveness through a second table, so the FK
 * column alone is not the rule. The decision still keys off the delete
 * policy's own `block` effect.
 */
const PRODUCT_BLOCK_GUARDS = Object.fromEntries(
  Object.entries(PRODUCT_RETAINING_DEPENDENTS).flatMap(([key, fetch]) => {
    if (!isRetainingEdgeKey(key)) return [];
    const disposition = PRODUCT_DELETE_EDGE_POLICY[key];
    if (disposition.effect !== "block") return [];
    const guard = async (tx: DrizzleTransaction, ids: ProductId[]) =>
      assertNoDependents({
        offendingParentIds: (await fetch(tx, ids)).map((d) => d.productId),
        fetchNames: (failedIds) =>
          tx.query.product.findMany({
            where: inArray(product.id, failedIds),
            columns: { name: true },
          }),
        reason: disposition.reason,
        message: (count, names) =>
          `Cannot delete ${count} product(s): ${names} have ${disposition.label}. Remove them first.`,
      });
    return [[key, guard]];
  }),
);

/**
 * Product deletes take uuids. Returns the R2 keys of images the cascade
 * reaped, for the caller to drop after this commit, and the ingredients whose
 * product roster changed.
 */
export const deleteProducts = (
  db: Database,
  ids: ProductId[],
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const ingredientIds = uniq(
      (
        await tx.query.product.findMany({
          where: inArray(product.id, ids),
          columns: { ingredientId: true },
        })
      ).flatMap((row) => row.ingredientId ?? []),
    );
    const removal = await deleteByPolicy(tx, {
      entity: "product",
      policy: PRODUCT_DELETE_EDGE_POLICY,
      ids,
      actor,
      overrides: PRODUCT_BLOCK_GUARDS,
    });
    return { ...removal, ingredientIds };
  });

export type ProductRepoCreateInput = Omit<
  ProductCreateInput,
  "ingredientId" | "growsPlantId" | "categoryId"
> & {
  ingredientId: IngredientId | null;
  growsPlantId?: PlantId | null;
  categoryId?: ProductCategoryId | null;
};

export type ProductRepoUpdateData = Omit<
  ProductUpdateInput["data"],
  "ingredientId" | "growsPlantId" | "categoryId"
> & {
  ingredientId?: IngredientId | null;
  growsPlantId?: PlantId | null;
  categoryId?: ProductCategoryId | null;
};
