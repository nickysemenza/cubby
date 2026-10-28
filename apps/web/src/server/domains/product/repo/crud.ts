import type { EntityRelationPageInput } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type ProductCreateInput,
  type ProductUpdateInput,
} from "@cubby/schemas/entities/product";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  isCollectionPatch,
  type ValueCollectionPatch,
} from "@cubby/schemas/entity-collection";
import type { ImageRawOut as RawImageOutput } from "@cubby/schemas/entity-contracts/image";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { EntityLinkKind } from "@cubby/schemas/entity-links";
import {
  displayGtin,
  type ExternalIdInput,
  type ExternalIdKind,
  type ExternalIdPatch,
  GTIN_KIND,
  GTIN_SOURCE,
  storedExternalIdUrl,
} from "@cubby/schemas/external-id";
import type {
  IngredientId,
  PlantId,
  LocationId,
  ProductId,
  ProductCategoryId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import {
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { ProductFilters } from "@cubby/schemas/product";
import { impliedProductFeature } from "@cubby/schemas/product";
import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import { type RawProductCategorySummary } from "@cubby/schemas/product-category-fields";
import { productQuantityVarianceState } from "@cubby/schemas/product-fields";
import type { RawProductPickerItem } from "@cubby/schemas/product-raw-read";
import {
  rawProductDetail,
  rawProductList,
} from "@cubby/schemas/product-raw-read";
import {
  type RawProductOutput,
  rawProductOutput,
} from "@cubby/schemas/product-raw-read";
import { productReadFacts } from "@cubby/schemas/product-read-fields";
import { foodSummary } from "@cubby/usda";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import {
  productAcquisitionDateFilterSql,
  productExpenseCountFilterSql,
  productExpenseTotalFilterSql,
  actualExpense,
} from "~/server/db/computed/expense-aggregate-sql";
import {
  productBrandNameSql,
  productBrandCodeSql,
} from "~/server/db/computed/product-brand-sql";
import {
  type CategoryStockTracking,
  categorySummarySql,
  categoryStockTrackingSql,
} from "~/server/db/computed/product-category-sql";
import { productClassificationEvidenceSql } from "~/server/db/computed/product-classification-evidence";
import {
  assertNoDependents,
  associatePendingImages,
  databaseForTransaction,
  formatSearchTerm,
  getDb,
  galleryBinding,
  isTransaction,
  mapImages,
  notDeleted,
  textArrayMatches,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import { rankOf } from "~/server/db/helpers/related";
import {
  cookbook,
  device,
  entityAttachment,
  entityExternalId,
  entityLink,
  expense,
  image,
  ingredient,
  inventoryEntry,
  importSourceProduct,
  location,
  mealFoodEntry,
  photoGroupProposal,
  planting,
  product,
  productCategory,
  productConversionCoverage,
  productUnitMappings,
  task,
} from "~/server/db/schema";
import { loadImageAnalysisSummaries } from "~/server/domains/image/repo/image-analysis-summary";
import { productHasDisplayableImageSql } from "~/server/domains/image/repo/image-displayability";
import { hydrateImageReadProjection } from "~/server/domains/image/repo/image-read-projection";
import { getRecipeUsagesForIngredient } from "~/server/domains/ingredient/repo/recipe-usages";
import { productOwnerFilterSql } from "~/server/domains/inventory/repo/ownership";
import { loadStoredInventoryValuations } from "~/server/domains/inventory/repo/valuation";
import { parseLocationType } from "~/server/domains/location/repo/parse-type";
import { loadLocationAncestorsWithIds } from "~/server/domains/location/repo/tree";
import { categoryFeatureSql } from "~/server/domains/product-category/repo/category-feature";
import {
  resolveProductCategory,
  loadCategorySummaries,
} from "~/server/domains/product-category/repo/product-category";
import {
  currentProductConversionCoverageCondition,
  markProductConversionCoverageInputStale,
} from "~/server/domains/product/repo/conversion-coverage";
import {
  loadPrimaryGtins,
  productHasGtin,
  productMatchesGtinTerm,
} from "~/server/domains/product/repo/gtin";
import { projectProductUnitPriceBatch } from "~/server/domains/product/repo/list-enrichment";
import { buildNutritionDisplay } from "~/server/domains/product/repo/nutrition-display";
import { productSearch as productSearchRead } from "~/server/domains/product/repo/search-read-product";
import { serviceCategorySql } from "~/server/domains/product/repo/service-category";
import { loadStoredProductDisplay } from "~/server/domains/product/repo/stored-display";
import { resolveProductBrand } from "~/server/domains/vendor/repo/product-brand";
import { externalIdsLabel } from "~/server/entity-kernel/repo/detail-display-labels";
import { resolveEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { insertPayloadWithIdentity } from "~/server/entity-kernel/repo/entity-identity-writer";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { findPgError } from "~/server/errors/db-errors";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import {
  storedDerivedSql,
  storedFieldAvailableSql,
} from "~/server/generic/derived/repo/read";
import {
  ensureExternalSources,
  lockExternalIdentifierParents,
} from "~/server/generic/entity-links/repo/entity-external-ids";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
import {
  loadProductComponentEvidence,
  loadProductExpenseEvidence,
} from "~/server/generic/field-explanation/repo/field-explanation-evidence";
import { validateLiveInheritedPolicies } from "~/server/generic/inheritance/repo/inheritance-validation";
import { listReadValue } from "~/server/generic/list/repo/field-compiler";
import { hierarchyDescendantsSql } from "~/server/generic/list/repo/hierarchy";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  expectedQuantityLabel,
  quantityVarianceLabel,
  unitPriceLabel,
} from "~/server/generic/list/repo/list-display-labels";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveLiveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { liveAliasSqlText } from "~/server/lib/live-row";

import { assertProductCategoryChange } from "./classification";
import {
  PRODUCT_DELETE_EDGE_POLICY,
  isRetainingEdgeKey,
  type ProductRetainingEdgeKey,
} from "./edge-roles";
import {
  splitProductImages,
  mapProductExternalIds,
  mapProductUnitMappings,
  mapProductListInventoryEntries,
  primaryGtinOf,
  mapDbProductIngredient,
  dbProductToPickerItemAPI,
  productFieldResolutions,
  productImageShortcodesOf,
} from "./mappers";
import { ownershipExitExpensePredicate } from "./ownership";
import {
  productReadPriceSql,
  productReadCostSql,
  resolveProductPricing,
} from "./pricing";
import { storedEffectivePrice } from "./pricing";
import {
  EMPTY_QUANTITY_LEDGER,
  expectedQuantityFilterSql,
  hasUnknownAcquisitionLinesSql,
  hasUnknownQuantityLinesSql,
  unknownQuantityLinesReadSql,
  onHandUnitsFilterSql,
  onHandUnitsSql,
} from "./quantity-ledger";
import { unitMappingColumns } from "./unit-mappings";
import {
  assertNoCanonicalPriceMapping,
  ensureSlotPrimaries,
  externalIdsContainIsbn,
  foldGtinIntoExternalIds,
  requireCanonicalGtin,
  resolvePrimaryProductCodeInput,
  syncProductExternalIds,
  syncProductImages,
  productGallerySnapshot,
  productGalleryIntent,
  syncProductUnitMappings,
} from "./update-helpers";

const qb = new QueryBuilder();

// Cross-entity filters stay uncorrelated id-set subqueries.
const productIdsWithLiveInventory = qb
  .select({ productId: inventoryEntry.productId })
  .from(inventoryEntry)
  .innerJoin(
    location,
    and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
  )
  .where(notDeleted(inventoryEntry));

// Products a Location IS an instance of. `onHandUnitsSql` counts them, so the
// variance gate unions them with live inventory.
const productIdsServingAsLocations = qb
  .select({ productId: location.productId })
  .from(location)
  .where(and(notDeleted(location), isNotNull(location.productId)));

const productIdsWithExpenses = qb
  .select({ productId: expense.productId })
  .from(expense)
  .where(and(notDeleted(expense), isNotNull(expense.productId)));

// Kit membership requires live parent and component rows; do not approximate liveness with stale joins.
const partsAccountedKitsSql = sql`(SELECT min(floor(COALESCE(${sql.raw(onHandUnitsSql("kac_p"))}, 0) / kac."quantity"))
       FROM "EntityLink" kac
       JOIN "Product" kac_p
         ON kac_p."id" = kac."toEntityId" AND ${notDeleted("kac_p")}
      WHERE kac."fromEntityId" = ${product.id}
        AND ${notDeleted("kac")} AND kac."kind" = 'productComponent')`;

// The entity-list form of the sold-but-still-stocked diagnostic. The quantity
// ledger remains the authority for expected quantity and unknown acquisition
// lines; the shared exit predicate keeps ordinary refunds/adjustments from
// reading as an ownership exit while including $0 hand-entered discards.
const productIdsWithRecordedDisposal = qb
  .select({ productId: expense.productId })
  .from(expense)
  .where(
    and(
      notDeleted(expense),
      actualExpense(),
      isNotNull(expense.productId),
      ownershipExitExpensePredicate(),
    ),
  );

const productIdsWithConversionCoverage = (condition: SQL) =>
  inArray(
    product.id,
    qb
      .select({ id: productConversionCoverage.productId })
      .from(productConversionCoverage)
      .where(and(currentProductConversionCoverageCondition(), condition)),
  );

// Mirrors `foodLookupParamFromProduct` returning a key (an explicit fdc_id or
// a barcode to auto-match), or a label nutrition override, which supersedes
// the USDA lookup outright. SQL cannot know whether the USDA worker resolves a
// food for that key, which is why the filter is labelled "USDA key".
const productHasUsdaKey = sql`(${product.fdc_id} IS NOT NULL OR ${product.labelNutrition} IS NOT NULL OR EXISTS (
    SELECT 1 FROM "EntityExternalId" pei
    WHERE pei."entityId" = ${product.id}
      AND pei."source" = ${GTIN_SOURCE}
      AND ${notDeleted("pei")}))`;

/** The declared read's row: stored columns plus the helper columns bindings read. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- matches listScaffold's default Row; bindings read declared keys by name.
type ProductReadRow = typeof product.$inferSelect & {
  readonly categorySummary: RawProductCategorySummary | null;
  readonly categoryStockTrackingValue: CategoryStockTracking | null;
  readonly [key: string]: unknown;
};

const readerDatabase = (db: Database | DrizzleTransaction): Database =>
  isTransaction(db) ? databaseForTransaction(db) : db;

/**
 * The Product read, stated once: list pages, selected projections, totals and
 * the single-record read all select through it.
 */
export const productScaffold = listScaffold<
  "product",
  typeof product,
  ProductReadRow
>("product", product, {
  derived: {
    location: sql.raw(
      `(SELECT min(l."name") FROM "InventoryEntry" ie ` +
        `JOIN "Location" l ON l."id" = ie."locationId" AND ${liveAliasSqlText("l")} ` +
        `WHERE ie."productId" = "Product"."id" AND ${liveAliasSqlText("ie")})`,
    ),
    brandId: productBrandNameSql(product.brandId),
    // Ranked once over categories: the path summary per Product was ~600 ms.
    categoryId: rankOf(
      productCategory,
      (id) => sql`${categorySummarySql(id)}::jsonb->'path'`,
      sql`${product.categoryId}`,
    ),
    // Stored (ADR 0021): the kit walk per row made price sorts ~300 ms.
    price: productReadPriceSql,
    cost: productReadCostSql,
    primaryGtin: sql.raw(
      `(SELECT pei."externalId" FROM "EntityExternalId" pei ` +
        `WHERE pei."entityId" = "Product"."id" AND pei."source" = 'gtin' AND ${liveAliasSqlText("pei")} ` +
        `ORDER BY pei."isPrimary" DESC, pei."createdAt", pei."id" LIMIT 1)`,
    ),
    expenseTotal: productExpenseTotalFilterSql(product.id),
    // `expenses` is the COLUMN id; `expenseCount` is the row field. See the
    // note on the column in app/products/productlist.tsx for why the id is
    // the half that cannot move.
    expenseCount: productExpenseCountFilterSql(product.id),
    // Ledger filters and sorts use the published typed projections.
    ledgerExpectedQuantity: storedDerivedSql(
      "product",
      "ledgerExpectedQuantity",
      product.id,
    ),
    quantityVariance: storedDerivedSql(
      "product",
      "quantityVariance",
      product.id,
    ),
    // Live stock/direct-Expense gates remain; state uses the published variance,
    // including null for incomparable quantities, without preparing live folds.
    quantityVarianceState: sql`CASE WHEN ${and(
      or(
        inArray(product.id, productIdsWithLiveInventory),
        inArray(product.id, productIdsServingAsLocations),
      ),
      inArray(product.id, productIdsWithExpenses),
    )} THEN CASE ${storedDerivedSql("product", "quantityVariance", product.id)} = 0
        WHEN true THEN ${productQuantityVarianceState.enum.matched}::text
        WHEN false THEN ${productQuantityVarianceState.enum.mismatched}::text END END`,
    // Same fragment the cell renders (relations.ts) and both filters use.
    purchaseDate: productAcquisitionDateFilterSql(product.id),
    upcPresence: inArray(
      product.id,
      qb
        .select({ productId: entityExternalId.entityId })
        .from(entityExternalId)
        .where(
          and(
            notDeleted(entityExternalId),
            eq(entityExternalId.source, GTIN_SOURCE),
          ),
        ),
    ),
    usdaKey: productHasUsdaKey,
    // The shared displayable-image definition: what the thumbnail cell renders.
    image: productHasDisplayableImageSql(product.id),
    inventoryMultiplicity: sql`(${eq(product.expectedQuantity, 1)} AND ${inArray(
      product.id,
      qb
        .select({ productId: inventoryEntry.productId })
        .from(inventoryEntry)
        .innerJoin(
          location,
          and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
        )
        .where(notDeleted(inventoryEntry))
        .groupBy(inventoryEntry.productId, inventoryEntry.placement)
        .having(sql`count(*) > 1`),
    )})`,
    kitAccounting: listReadValue((read) => {
      const onHand = onHandUnitsFilterSql(product.id, read);
      const expected =
        read?.derivedValue?.("expectedQuantity", product.id) ??
        expectedQuantityFilterSql(product.id);
      // Unknown stock is not applicable; make that false before expensive kit work.
      return sql`((${onHand} > 0) IS TRUE AND ${partsAccountedKitsSql} > 0
        AND ${onHand} + ${partsAccountedKitsSql} > ${expected})`;
    }),
    ownershipReconciliation: listReadValue(
      (read) => sql`(${inArray(product.id, productIdsWithRecordedDisposal)}
        AND (${onHandUnitsFilterSql(product.id, read)} > 0) IS TRUE
        AND ${expectedQuantityFilterSql(product.id)} <= 0
        AND NOT ${hasUnknownAcquisitionLinesSql(product.id)})`,
    ),
    conversionCoverage: productIdsWithConversionCoverage(
      eq(productConversionCoverage.coverageTier, "partial"),
    ),
    conversionTopology: productIdsWithConversionCoverage(
      sql`${productConversionCoverage.islandCount} >= 2`,
    ),
    unitMappingQuality: inArray(
      product.id,
      qb
        .select({ productId: productUnitMappings.productId })
        .from(productUnitMappings)
        .where(notDeleted(productUnitMappings)),
    ),
    // ADR 0013: the undecided worklist reads the effective decision, so a
    // category default takes its members out of it.
    stockTrackedDecided: sql`${effectiveFieldSql("product", "stockTracked")} IS NOT NULL`,
    miscBucket: sql`lower(${product.name}) LIKE 'misc:%'`,
    unknownQuantityLines: {
      value: hasUnknownQuantityLinesSql(product.id),
      set: unknownQuantityLinesReadSql(),
    },
    priced: sql`CASE WHEN ${serviceCategorySql(sql`${product.categoryId}`)} THEN false
      WHEN ${productReadPriceSql} IS NOT NULL THEN true
      WHEN ${storedFieldAvailableSql("product", "price", product.id, { currentValue: productReadPriceSql })} THEN false
      ELSE NULL::boolean END`,
    effectiveOwner: (value) =>
      productOwnerFilterSql(value.values, value.presence),
  },
  read: {
    search: productSearchRead,
    evidence: {
      componentCount: loadProductComponentEvidence,
      expenseCount: loadProductExpenseEvidence,
    },
    columns: {
      // Derived `brandId`, `categoryId`, `price` and `cost` are sort values;
      // the read keeps the stored reference and manual price, and `cost` is
      // published from the stored derived value, never from this row.
      brandId: product.brandId,
      price: product.price,
      cost: sql<null>`NULL`,
      expenseCount: sql<number>`(${productExpenseCountFilterSql(product.id)})::int`,
      // Same live-edge predicate as the kit filter and the detail hero.
      componentCount: sql<number>`(SELECT count(*)::int FROM ${entityLink}
        WHERE ${entityLink.fromEntityId} = ${product.id}
          AND ${liveLinks("productComponent")})`,
      classificationEvidence: productClassificationEvidenceSql(
        sql`${product.id}`,
      ),
      // Helper columns the category and stock bindings read on every page.
      categorySummary: categorySummarySql(sql`${product.categoryId}`),
      categoryStockTrackingValue: categoryStockTrackingSql(
        sql`${product.categoryId}`,
      ),
    },
    media: true,
    bindings: (bind) => {
      const productIds = (ids: readonly string[]) =>
        uniq(ids.map((id) => parseEntityId("product", id)));
      const grouped = <Row extends object>(
        ids: readonly string[],
        rows: readonly Row[],
        key: (row: Row) => string,
      ) => {
        const result = new Map<ProductId, Row[]>(
          productIds(ids).map((id) => [id, []]),
        );
        for (const row of rows)
          result.get(parseEntityId("product", key(row)))?.push(row);
        return result;
      };
      const attachments = bind.ids(async ({ db, ids }) =>
        grouped(
          ids,
          await unwrapDb(db).query.entityAttachment.findMany({
            where: and(
              inArray(entityAttachment.entityId, productIds(ids)),
              notDeleted(entityAttachment),
            ),
            orderBy: [
              asc(entityAttachment.sortOrder),
              asc(entityAttachment.createdAt),
            ],
            with: { image: true },
          }),
          (row) => row.entityId,
        ),
      );
      const externalIds = bind.ids(async ({ db, ids }) =>
        grouped(
          ids,
          await unwrapDb(db).query.entityExternalId.findMany({
            where: and(
              inArray(entityExternalId.entityId, productIds(ids)),
              notDeleted(entityExternalId),
            ),
          }),
          (row) => row.entityId,
        ),
      );
      const unitMappings = bind.ids(async ({ db, ids }) =>
        grouped(
          ids,
          await unwrapDb(db).query.productUnitMappings.findMany({
            where: and(
              inArray(productUnitMappings.productId, productIds(ids)),
              notDeleted(productUnitMappings),
            ),
          }),
          (row) => row.productId,
        ),
      );
      const inventory = bind.ids(async ({ db, ids }) => {
        const entries = await unwrapDb(db).query.inventoryEntry.findMany({
          where: and(
            inArray(inventoryEntry.productId, productIds(ids)),
            notDeleted(inventoryEntry),
          ),
          orderBy: inventoryEntry.createdAt,
          with: { location: true },
        });
        const valuations = await loadStoredInventoryValuations(
          db,
          entries.map((row) => row.id),
        );
        const byProduct = grouped(
          ids,
          entries.map((row) => ({
            ...row,
            valuation: valuations.get(row.id) ?? null,
          })),
          (row) => row.productId,
        );
        return new Map(
          [...byProduct].map(([id, rows]) => [
            id,
            mapProductListInventoryEntries(rows),
          ]),
        );
      });
      const stored = bind.ids(
        (page) =>
          page.stored ??
          loadStoredDerived(page.db, "product", page.ids, [
            "price",
            "cost",
            "readFacts",
            "food",
          ]),
      );
      const facts = bind.ids(async (page) => {
        const published = await stored.load(page);
        return new Map(
          page.ids.map((id) => {
            const read = published.get(id)?.get("readFacts");
            return [
              id,
              read?.resultExists ? productReadFacts.parse(read.value) : null,
            ];
          }),
        );
      });
      const pricing = bind.batch(async (page) => {
        const published = await stored.load(page.idPage);
        const snapshots = await facts.load(page.idPage);
        return new Map(
          page.rows.map((row) => {
            const saved =
              snapshots.get(row.id)?.pricing ?? resolveProductPricing(null);
            const effectivePrice = storedEffectivePrice(published, {
              ...row,
              category: row.categorySummary,
            });
            const selected = {
              ...saved,
              effectivePrice,
              source:
                row.price !== null &&
                !isServiceProductCategory(row.categorySummary)
                  ? "explicit"
                  : effectivePrice !== null
                    ? "derived"
                    : "none",
            } satisfies typeof saved;
            return [row.id, selected];
          }),
        );
      });
      const stock = bind.batch(async (page) => ({
        facts: await facts.load(page.idPage),
        prices: await pricing.load(page),
      }));
      const ingredients = bind.batch(async ({ db, rows }) => {
        const ids = uniq(
          rows.flatMap((row) => (row.ingredientId ? [row.ingredientId] : [])),
        );
        const loaded =
          ids.length === 0
            ? []
            : await unwrapDb(db).query.ingredient.findMany({
                where: and(inArray(ingredient.id, ids), notDeleted(ingredient)),
              });
        return new Map(loaded.map((row) => [row.id, row]));
      });
      // Read the published USDA facts; request readers never call the release DO.
      const food = bind.batch(async (page) => {
        const identities = await externalIds.load(page.idPage);
        const mappings = await unitMappings.load(page.idPage);
        const prices = await pricing.load(page);
        const published = await stored.load(page.idPage);
        const prepared = page.rows.map((row) => {
          const id = parseShortcodeFor("product", row.shortcode);
          const price = prices.get(row.id);
          if (!price) throw new Error("Product food binding requires pricing");
          const read = published.get(row.id)?.get("food");
          const food = read?.resultExists
            ? foodSummary.nullable().parse(read.value)
            : null;
          const seed = {
            id,
            primaryGtin: primaryGtinOf(identities.get(row.id)),
            fdc_id: row.fdc_id,
            price: row.price,
            pricing: price,
            labelNutrition: row.labelNutrition,
            unitMappings: mapProductUnitMappings(
              id,
              mappings.get(row.id) ?? [],
            ),
          };
          return {
            rowId: row.id,
            seed,
            food,
            service: isServiceProductCategory(row.categorySummary),
          };
        });
        const projections = projectProductUnitPriceBatch(
          prepared.map(({ seed, food, service }) => ({
            product: { ...seed, food },
            price: seed.pricing.effectivePrice,
            service,
          })),
        );
        return new Map(
          prepared.map(({ rowId, seed, food }, index) => {
            const projection = projections[index];
            if (!projection)
              throw new Error("Product display batch omitted a selected row");
            return [
              rowId,
              {
                seed,
                value: {
                  food,
                  unitPriceMappings: projection.unitPriceMappings,
                  ...projection.values,
                },
              },
            ];
          }),
        );
      });
      const analyses = bind.ids(async (page) => {
        const loaded = await attachments.load(page);
        return {
          attachments: loaded,
          summaries: await loadImageAnalysisSummaries(
            page.db,
            [...loaded.values()].flatMap((rows) =>
              productImageShortcodesOf(rows),
            ),
          ),
        };
      });
      const foodOf = (
        loaded: Awaited<ReturnType<typeof food.load>>,
        id: ProductId,
      ) => {
        const value = loaded.get(id);
        if (!value)
          throw new Error("Product food binding omitted a selected row");
        return value;
      };
      const covers = bind.ids(({ db, ids }) =>
        getProductCoverImageUrlsByProductIds(db, productIds(ids)),
      );
      const servingAsLocations = bind.ids(async ({ db, ids }) => {
        const rows = await unwrapDb(db).query.location.findMany({
          where: and(
            inArray(location.productId, productIds(ids)),
            notDeleted(location),
          ),
        });
        const database = readerDatabase(db);
        const ancestorsById = await loadLocationAncestorsWithIds(
          database,
          rows.map((row) => row.id),
        );
        const displayImages = await resolveEntityDisplayImages(
          db,
          uniq([
            ...rows.map((row) => row.id),
            ...[...ancestorsById.values()].flatMap((chain) =>
              chain.map((rung) => rung.locationId),
            ),
          ]).map((entityId) => ({ entityKind: "location" as const, entityId })),
        );
        const displayImageOf = (id: LocationId) =>
          displayImages.get(entityRefKey("location", id)) ?? null;
        return grouped(
          ids,
          rows.map((row) => ({
            id: parseShortcodeFor("location", row.shortcode),
            name: row.name,
            type: parseLocationType(row.type),
            displayImage: displayImageOf(row.id),
            ancestors: (ancestorsById.get(row.id) ?? []).map(
              ({ locationId, ...rung }) => ({
                ...rung,
                displayImage: displayImageOf(locationId),
              }),
            ),
            productId: row.productId ?? "",
          })),
          (row) => row.productId,
        );
      });
      const cookbooks = bind.ids(async ({ db, ids }) =>
        grouped(
          ids,
          await unwrapDb(db).query.cookbook.findMany({
            where: and(
              inArray(cookbook.productId, productIds(ids)),
              notDeleted(cookbook),
            ),
            orderBy: asc(cookbook.name),
          }),
          (row) => row.productId ?? "",
        ),
      );
      const recipeUsages = bind.batch(async (page) => {
        const linked = await ingredients.load(page);
        const database = readerDatabase(page.db);
        const usages = new Map<
          ProductId,
          Awaited<
            ReturnType<typeof getRecipeUsagesForIngredient>
          >["recipeUsages"]
        >();
        for (const row of page.rows) {
          const live = row.ingredientId
            ? linked.get(row.ingredientId)
            : undefined;
          usages.set(
            row.id,
            live
              ? (await getRecipeUsagesForIngredient(database, live.id))
                  .recipeUsages
              : [],
          );
        }
        return usages;
      });
      return [
        bind(
          rawProductList.pick({ modelPresence: true, notesPresence: true }),
          (row) => ({
            modelPresence: Boolean(row.model),
            notesPresence: Boolean(row.notes),
          }),
        ),
        bind(rawProductList.pick({ dataGaps: true }), (_row, { quality }) => {
          if (!quality)
            throw new Error("Product data gaps require loaded quality");
          return {
            dataGaps: rawProductList.shape.dataGaps.parse(
              quality.gaps.map((gap) => gap.check),
            ),
          };
        }),
        bind(
          rawProductList.pick({
            category: true,
            categoryId: true,
            categoryFeature: true,
          }),
          (row) => ({
            category: row.categorySummary,
            categoryId: row.categorySummary?.id ?? null,
            // The category SQL resolves inheritance before the compact projection.
            categoryFeature: row.categorySummary?.feature ?? null,
          }),
        ),
        ingredients.fields(
          rawProductList.pick({ ingredient: true }),
          (row, loaded) => {
            const linked = row.ingredientId
              ? loaded.get(row.ingredientId)
              : undefined;
            return {
              ingredient: linked ? mapDbProductIngredient(linked) : null,
            };
          },
        ),
        inventory.fields(
          rawProductList.pick({ inventoryEntry: true }),
          (row, loaded) => ({ inventoryEntry: loaded.get(row.id) ?? [] }),
        ),
        externalIds.fields(
          rawProductList.pick({ externalIds: true }),
          (row, loaded) => ({
            externalIds: mapProductExternalIds(loaded.get(row.id)),
          }),
        ),
        externalIds.fields(
          rawProductDetail.pick({ externalIdsLabel: true }),
          (row, loaded) => ({
            externalIdsLabel: externalIdsLabel(
              mapProductExternalIds(loaded.get(row.id)),
            ),
          }),
          { scope: "detail" },
        ),
        unitMappings.fields(
          rawProductList.pick({ unitMappings: true }),
          (row, loaded) => ({
            unitMappings: mapProductUnitMappings(
              parseShortcodeFor("product", row.shortcode),
              loaded.get(row.id) ?? [],
            ),
          }),
        ),
        attachments.fields(
          rawProductList.pick({
            images: true,
            labelImages: true,
            itemImageCount: true,
            labelImageCount: true,
          }),
          (row, loaded) => {
            const { itemImages, ...groups } = splitProductImages(
              loaded.get(row.id),
            );
            return { ...groups, images: itemImages };
          },
        ),
        // A record read carries each image's analysis summary; a page stays a
        // single attachment query regardless of image count.
        analyses.fields(
          rawProductDetail.pick({ images: true, labelImages: true }),
          (row, loaded) => {
            const { itemImages, labelImages } = splitProductImages(
              loaded.attachments.get(row.id),
              loaded.summaries,
            );
            return { images: itemImages, labelImages };
          },
          { scope: "detail" },
        ),
        stock.fields(
          rawProductList.pick({
            pricing: true,
            fieldResolutions: true,
            quantityLedger: true,
            quantityVariance: true,
            stockStatusItems: true,
            ledgerExpectedQuantityLabel: true,
            quantityVarianceLabel: true,
          }),
          (row, loaded) => {
            const pricing = loaded.prices.get(row.id);
            if (!pricing)
              throw new Error("Product stock binding requires pricing");
            const snapshot = loaded.facts.get(row.id);
            const service = isServiceProductCategory(row.categorySummary);
            // The raw shape needs a ledger; the field envelope keeps a missing
            // publication unavailable rather than presenting these placeholders.
            const quantityLedger =
              snapshot?.quantityLedger ?? EMPTY_QUANTITY_LEDGER;
            const fieldResolutions = productFieldResolutions(
              {
                price: row.price,
                stockTracked: row.stockTracked,
                category: row.categorySummary,
                categoryStockTracking: row.categoryStockTrackingValue,
              },
              pricing,
            );
            return {
              pricing,
              fieldResolutions,
              quantityLedger,
              quantityVariance: snapshot?.quantityVariance ?? null,
              stockStatusItems: snapshot?.stockStatusItems ?? [],
              ledgerExpectedQuantityLabel:
                service || !snapshot
                  ? null
                  : expectedQuantityLabel(quantityLedger),
              quantityVarianceLabel: quantityVarianceLabel(
                snapshot?.quantityVariance ?? null,
              ),
            };
          },
        ),
        food.fields(
          rawProductList.pick({
            food: true,
            unitPrice: true,
            unitPriceMappings: true,
            unitPriceLabel: true,
          }),
          (row, loaded) => {
            const value = foodOf(loaded, row.id).value;
            return {
              food: value.food,
              unitPrice: value.unitPrice,
              unitPriceMappings: value.unitPriceMappings,
              unitPriceLabel: unitPriceLabel(value.unitPrice),
            };
          },
        ),
        food.fields(
          rawProductDetail.pick({
            unitPriceDetailLabel: true,
            nutritionDisplay: true,
          }),
          (row, loaded) => {
            const { value } = foodOf(loaded, row.id);
            return {
              unitPriceDetailLabel: value.unitPriceDetailLabel,
              nutritionDisplay: buildNutritionDisplay({
                labelNutrition: row.labelNutrition,
                food: value.food,
              }),
            };
          },
          { scope: "detail" },
        ),
        facts.fields(
          rawProductDetail.pick({ ownershipEvidence: true }),
          (row, loaded) => {
            return {
              ownershipEvidence:
                loaded.get(row.id)?.ownershipEvidence ??
                productReadFacts.shape.ownershipEvidence.parse({
                  state: "uncertain",
                  acquiredAt: null,
                  exitedAt: null,
                  confidenceLostAt: null,
                }),
            };
          },
          { scope: "detail" },
        ),
        covers.fields(
          rawProductDetail.pick({ coverImageUrl: true }),
          (row, loaded) => ({ coverImageUrl: loaded.get(row.id) ?? null }),
          { scope: "detail" },
        ),
        servingAsLocations.fields(
          rawProductDetail.pick({ servingAsLocations: true }),
          (row, loaded) => ({
            servingAsLocations: (loaded.get(row.id) ?? []).map(
              ({ productId: _productId, ...ref }) => ref,
            ),
          }),
          { scope: "detail" },
        ),
        cookbooks.fields(
          rawProductDetail.pick({ cookbooks: true }),
          (row, loaded) => ({
            cookbooks: (loaded.get(row.id) ?? []).map((book) => ({
              id: parseShortcodeFor("cookbook", book.shortcode),
              name: book.name,
            })),
          }),
          { scope: "detail" },
        ),
        recipeUsages.fields(
          rawProductDetail.pick({ recipeUsages: true }),
          (row, loaded) => ({ recipeUsages: loaded.get(row.id) ?? [] }),
          { scope: "detail" },
        ),
      ];
    },
  },
});

const productListOrderBy = (sorts: SortParams[], filters?: ProductFilters) =>
  productScaffold.orderBy(
    sorts,
    { tieBreaker: sql`${product.name} ASC, ${product.shortcode} ASC` },
    filters,
  );

const productReader = createEntityReader({
  entity: "product",
  scaffold: productScaffold,
  output: rawProductDetail,
});
/** One live Product by internal id; throws `PRODUCT_NOT_FOUND`. */
export const readProductById = productReader.getByID;
/** One live Product by public code, or null. */
export const readProduct = productReader.getByShortcode;
/** Live Products by public code through the declared read. */
export const readProducts = async (
  db: Database | DrizzleTransaction,
  shortcodes: readonly string[],
) => {
  if (shortcodes.length === 0) return [];
  // Callers pass member-typed shortcodes; stored shortcodes are uppercase.
  const { data } = await productScaffold.get(
    db,
    shortcodes.map((code) => code.toUpperCase()),
  );
  return data.map((row) => rawProductDetail.parse(row));
};

/** The record a writer returns, read back through the declared read. */
const readWrittenProduct = async (
  db: Database | DrizzleTransaction,
  id: ProductId,
): Promise<RawProductOutput> => {
  const [row] = (await productScaffold.getByIds(db, [id])).data;
  return rawProductOutput.parse(row);
};

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
): Promise<Record<string, RawImageOutput[]>> => {
  const uniqueIds = uniq(ids);
  const result: Record<string, RawImageOutput[]> = Object.fromEntries(
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

/** Narrow root-table projection for relation paging; the scaffold owns the count. */
export function pageProductRelationTargets(
  db: Database,
  where: SQL | undefined,
  orderBy: SQL[],
  input: Pick<EntityRelationPageInput, "offset" | "limit">,
) {
  return productScaffold.raw(
    db,
    {
      filters: {},
      sorts: [],
      pagination: { pageIndex: 0, pageSize: input.limit },
      projection: [],
    },
    {
      where,
      orderBy,
      select: (page) =>
        getDb(db)
          .select({ id: product.id, code: product.shortcode })
          .from(product)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(input.offset),
    },
  );
}

/**
 * A product's cover URL for a batch of picker or relationship rows: `[0]` of
 * the shared display-image policy (`resolveEntityDisplayImages`), so a picker
 * row, a list thumbnail and a search hit can never disagree about which photo
 * is the cover. Full image projections still use `getProductImagesByProductIds`.
 */
export const getProductCoverImageUrlsByProductIds = async (
  db: Database | DrizzleTransaction,
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
 * ingredient / unit-mapping / external-id relation graph that `productScaffold`
 * reads. Pickers get identity, compact quantity evidence, and one batched cover
 * URL without pretending to carry full product rows.
 */
export const productSearch = async (
  db: Database,
  filters: Pick<
    ProductFilters,
    | "nameFilter"
    | "brandFilter"
    | "upcFilter"
    | "categoryFilter"
    | "categoryFeatureFilter"
  >,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: RawProductPickerItem[]; count: number }> => {
  const name = filters.nameFilter;
  const whereClause = and(
    notDeleted(product),
    name !== undefined && name.trim() !== ""
      ? or(
          formatSearchTerm(product.name, name),
          formatSearchTerm(product.notes, name),
          textArrayMatches(product.aliases, name),
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
    formatSearchTerm(productBrandNameSql(product.brandId), filters.brandFilter),
    filters.upcFilter ? productMatchesGtinTerm(filters.upcFilter) : undefined,
    filters.categoryFilter?.length
      ? sql`${product.categoryId} IN ${hierarchyDescendantsSql("productCategory", await resolveAllOrThrow(db, "productCategory", Array.isArray(filters.categoryFilter) ? filters.categoryFilter : [filters.categoryFilter]))}`
      : undefined,
  );

  const page = await productScaffold.raw(
    db,
    { filters, sorts, pagination },
    {
      where: whereClause,
      orderBy: productListOrderBy(sorts),
      load: (where) =>
        getDb(db).query.product.findMany({
          where,
          extras: {
            brandName: productBrandNameSql(product.brandId).as("brandName"),
            brandCode: productBrandCodeSql(product.brandId).as("brandCode"),
          },
        }),
    },
  );
  const count = z.number().parse(page.count);
  if (!page.data.length) return { ...page, count, data: [] };
  const resultIds = page.data.map((result) => result.id);
  const [categories, display, coverImageUrls] = await Promise.all([
    loadCategorySummaries(db),
    loadStoredProductDisplay(db, resultIds),
    getProductCoverImageUrlsByProductIds(db, resultIds),
  ]);
  return {
    ...page,
    count,
    data: page.data.map((result) =>
      dbProductToPickerItemAPI({
        ...result,
        category: result.categoryId
          ? (categories.get(result.categoryId) ?? null)
          : null,
        quantityLedger:
          display.facts.get(result.id)?.value?.quantityLedger ?? null,
        onHand: display.facts.get(result.id)?.value?.pickerOnHand ?? {
          state: "unavailable",
        },
        displayFacts: {
          available: display.facts.get(result.id)?.value != null,
          stale: display.facts.get(result.id)?.stale ?? false,
        },
        price: storedEffectivePrice(display.stored, {
          ...result,
          category: categories.get(result.categoryId!) ?? null,
        }),
        coverImageUrl: coverImageUrls.get(result.id) ?? null,
      }),
    ),
  };
};

export const getProductPickerItemsByIds = async (
  db: Database,
  ids: ProductId[],
): Promise<RawProductPickerItem[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.product.findMany({
    // `inArray`, NOT sql`col = ANY(${arr})`: drizzle expands a JS array in a
    // template into a row constructor (`ANY(($1, $2))`), which postgres rejects.
    where: and(inArray(product.id, ids), notDeleted(product)),
    extras: {
      brandName: productBrandNameSql(product.brandId).as("brandName"),
      brandCode: productBrandCodeSql(product.brandId).as("brandCode"),
    },
    columns: {
      id: true,
      shortcode: true,
      name: true,
      brandId: true,
      categoryId: true,
      price: true,
    },
  });
  const categories = await loadCategorySummaries(db);
  const rowIds = rows.map((row) => row.id);
  const [display, coverImageUrls] = await Promise.all([
    loadStoredProductDisplay(db, rowIds),
    getProductCoverImageUrlsByProductIds(db, rowIds),
  ]);
  const byId = new Map(
    rows.map((row) => [
      row.id,
      dbProductToPickerItemAPI({
        ...row,
        category: categories.get(row.categoryId!) ?? null,
        quantityLedger:
          display.facts.get(row.id)?.value?.quantityLedger ?? null,
        onHand: display.facts.get(row.id)?.value?.pickerOnHand ?? {
          state: "unavailable",
        },
        displayFacts: {
          available: display.facts.get(row.id)?.value != null,
          stale: display.facts.get(row.id)?.stale ?? false,
        },
        price: storedEffectivePrice(display.stored, {
          ...row,
          category: categories.get(row.categoryId!) ?? null,
        }),
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
 * Translate a Product unique-constraint violation into a clear, actionable
 * CONFLICT error (naming the conflicting product/ingredient where possible).
 * No-op if the error isn't a unique violation, so callers can rethrow.
 */
async function throwIfDuplicateProduct<TError>(
  db: Database,
  data: { name: string; brandId: string | null } & {
    upc?: string | null;
  },
  error: TError,
): Promise<void> {
  const violation = findPgError(error);
  if (violation?.code !== "23505") return;
  const constraint = violation.constraint ?? "";

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

  if (constraint.includes("name_brandId")) {
    // Re-read the blocker rather than echoing the input back. Without this the
    // message says only that *something* named this exists, and the next step
    // is always a list/search call to find out what — so name it here. The
    // conflicting row is what the caller needs to merge into, rename, or skip.
    const existing = await getDb(db).query.product.findFirst({
      where: and(
        eq(product.name, data.name),
        data.brandId === null
          ? sql`${product.brandId} IS NULL`
          : sql`(${product.brandId}::text = ${data.brandId} OR ${productBrandCodeSql(product.brandId)} = ${data.brandId})`,
        notDeleted(product),
      ),
      columns: { name: true, shortcode: true },
    });
    throw createAppError(
      "PRODUCT_ALREADY_EXISTS",
      existing
        ? `A product named “${data.name}” by “${data.brandId ?? "unknown brand"}” already exists: ${existing.shortcode}.`
        : `A product named “${data.name}” by “${data.brandId ?? "unknown brand"}” already exists.`,
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
  readWrittenProduct: typeof readWrittenProduct;
};
const defaultProductCreateReads: ProductCreateReads = {
  readWrittenProduct,
};

export const createProduct = async (
  db: Database,
  data: ProductRepoCreateInput,
  actor: ActorContext,
  reads: ProductCreateReads = defaultProductCreateReads,
): Promise<RawProductOutput> =>
  (await createProductRecord(db, data, actor, reads)).output;

/** `createProduct` with the inserted row's id, so a caller never re-resolves the code it just minted. */
export function createProductRecord(
  db: Database,
  data: ProductRepoCreateInput,
  actor: ActorContext,
  reads?: ProductCreateReads,
): Promise<{ output: RawProductOutput; entityId: ProductId }>;
export function createProductRecord<TOutput>(
  db: Database,
  data: ProductRepoCreateInput,
  actor: ActorContext,
  reads: ProductCreateReads | undefined,
  readOutput: (
    tx: DrizzleTransaction,
    row: typeof product.$inferSelect,
  ) => Promise<TOutput>,
): Promise<{ output: TOutput; entityId: ProductId }>;
export async function createProductRecord<TOutput>(
  db: Database,
  data: ProductRepoCreateInput,
  actor: ActorContext,
  reads: ProductCreateReads = defaultProductCreateReads,
  readOutput?: (
    tx: DrizzleTransaction,
    row: typeof product.$inferSelect,
  ) => Promise<TOutput>,
): Promise<{ output: RawProductOutput | TOutput; entityId: ProductId }> {
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
      // A bare barcode becomes a GTIN identifier row rather than a column, and
      // is folded into the payload so it cannot be lost to (or lose to) an
      // explicit `externalIds` on the same call.
      const { barcode, ...columnData } = productData;
      const incomingGtin = resolvePrimaryProductCodeInput(barcode);
      const desiredExternalIds =
        incomingGtin === undefined || incomingGtin === null
          ? (externalIds ?? [])
          : foldGtinIntoExternalIds(externalIds ?? [], incomingGtin);
      const categoryId = await resolveProductCategory(
        tx,
        data.categoryId ?? null,
        impliedProductFeature({
          fdc_id: data.fdc_id,
          ingredientId,
          hasIsbn: externalIdsContainIsbn(desiredExternalIds),
        }),
      );
      await assertExternalIdsAvailable(tx, desiredExternalIds);
      const newProduct = await insertWithShortcode(tx, "product", {
        ...columnData,
        brandId: await resolveProductBrand(tx, productData.brandId),
        categoryId,
        ingredientId: ingredientId ?? null,
      });
      await lockExternalIdentifierParents(tx, [
        { entityId: newProduct.id, entityKind: "product" },
      ]);

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
          galleryBinding("product"),
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
      }

      await logAuditEntry(tx, actor, {
        entityKind: "product",
        entityId: newProduct.id,
        action: "create",
      });

      if (readOutput)
        return {
          output: await readOutput(tx, newProduct),
          entityId: newProduct.id,
        };
      return {
        output: await reads.readWrittenProduct(tx, newProduct.id),
        entityId: newProduct.id,
      };
    });
  } catch (error) {
    await throwIfDuplicateProduct(db, data, error);
    throw error;
  }
}

/** The entity kernel resolves text-collection patches before a repository sees them. */
const resolvedTextCollection = (
  field: string,
  value: string[] | ValueCollectionPatch | undefined,
): string[] | undefined => {
  if (value === undefined || !isCollectionPatch(value)) return value;
  throw new Error(`Product ${field} patch reached the repository unresolved`);
};

const isExternalIdPatch = (
  value: ExternalIdInput[] | ExternalIdPatch,
): value is ExternalIdPatch => isCollectionPatch(value);

/**
 * `detachedImageKeys` are R2 objects that `removeImageIds` reaped. They have no
 * rollback, so they ride out of the transaction rather than being dropped inside
 * it; `updateProductWithFood` drains them once the commit is real.
 */
export function updateProduct(
  db: Database,
  id: ProductId,
  data: ProductRepoUpdateData,
  actor: ActorContext,
): Promise<{ product: RawProductOutput; detachedImageKeys: string[] }>;
export function updateProduct<TOutput>(
  db: Database,
  id: ProductId,
  data: ProductRepoUpdateData,
  actor: ActorContext,
  readOutput: (
    tx: DrizzleTransaction,
    row: typeof product.$inferSelect,
  ) => Promise<TOutput>,
): Promise<{ product: TOutput; detachedImageKeys: string[] }>;
export async function updateProduct<TOutput>(
  db: Database,
  id: ProductId,
  data: ProductRepoUpdateData,
  actor: ActorContext,
  readOutput?: (
    tx: DrizzleTransaction,
    row: typeof product.$inferSelect,
  ) => Promise<TOutput>,
): Promise<{
  product: RawProductOutput | TOutput;
  detachedImageKeys: string[];
}> {
  const {
    ingredientId,
    unitMappings,
    externalIds: externalIdsInput,
    pendingImageIds,
    pendingImagePurposes,
    removeImageIds,
    imageOrder,
    ...productData
  } = data;
  // `externalIds` is a full replacement or a patch list (collection patching).
  const externalIdPatchItems =
    externalIdsInput !== undefined && isExternalIdPatch(externalIdsInput)
      ? externalIdsInput
      : undefined;
  const externalIds =
    externalIdsInput !== undefined && !isExternalIdPatch(externalIdsInput)
      ? externalIdsInput
      : undefined;

  const classificationRequested =
    externalIdsInput !== undefined ||
    data.barcode !== undefined ||
    data.categoryId !== undefined ||
    ingredientId !== undefined ||
    data.fdc_id !== undefined;
  let detachedImageKeys: string[] = [];

  // The identity this update lands on, captured inside the transaction for the
  // duplicate handler outside it — a rename collides on the SAME indexes a
  // create does, and used to surface as the generic "a product with that name,
  // brandName already exists" with no way to tell which product that was.
  let effectiveIdentity: {
    name: string;
    brandId: VendorId | null;
    upc?: string | null;
  } | null = null;

  const prepareUpdate = async (
    tx: DrizzleTransaction,
    beforeProduct: typeof product.$inferSelect,
    beforeExternalIds: Array<typeof entityExternalId.$inferSelect>,
    resolvedBrandId: VendorId | null | undefined,
  ) => {
    if (unitMappings !== undefined) assertNoCanonicalPriceMapping(unitMappings);
    const { barcode, aliases, tags, ...columnData } = productData;
    const incomingGtin = resolvePrimaryProductCodeInput(barcode);
    const desiredExternalIds =
      externalIds === undefined
        ? undefined
        : incomingGtin === undefined
          ? externalIds
          : foldGtinIntoExternalIds(externalIds, incomingGtin);
    effectiveIdentity = {
      name: columnData.name ?? beforeProduct.name,
      brandId:
        resolvedBrandId === undefined ? beforeProduct.brandId : resolvedBrandId,
      upc: incomingGtin ?? undefined,
    };
    const updateData: Partial<typeof product.$inferInsert> = {
      ...columnData,
      brandId: effectiveIdentity.brandId,
      aliases: resolvedTextCollection("aliases", aliases),
      tags: resolvedTextCollection("tags", tags),
    };
    if (ingredientId !== undefined) updateData.ingredientId = ingredientId;
    const resultingExternalIds = desiredExternalIds ?? [
      ...(incomingGtin === undefined
        ? beforeExternalIds
        : incomingGtin === null
          ? beforeExternalIds.filter((entry) => !entry.isPrimary)
          : [
              ...beforeExternalIds.filter(
                (entry) => entry.externalId !== incomingGtin,
              ),
              { source: GTIN_SOURCE, externalId: incomingGtin },
            ]),
      ...(externalIdPatchItems ?? []).flatMap((item) =>
        item.op === "add" ? [item.key] : [],
      ),
    ];
    const impliedFeature = classificationRequested
      ? impliedProductFeature({
          fdc_id:
            updateData.fdc_id === undefined
              ? beforeProduct.fdc_id
              : updateData.fdc_id,
          ingredientId:
            updateData.ingredientId === undefined
              ? beforeProduct.ingredientId
              : updateData.ingredientId,
          hasIsbn: externalIdsContainIsbn(resultingExternalIds),
        })
      : null;
    if (impliedFeature !== null) {
      updateData.categoryId = await resolveProductCategory(
        tx,
        updateData.categoryId === undefined
          ? beforeProduct.categoryId
          : updateData.categoryId,
        impliedFeature,
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
      return;
    }
    if (externalIdPatchItems !== undefined)
      await applyProductExternalIdPatch(tx, id, externalIdPatchItems);
    if (incomingGtin !== undefined)
      await applyPrimaryBarcode(tx, id, incomingGtin);
  };

  try {
    const updatedProduct = await withTransaction(db, async (tx) => {
      // Vendor merge locks identities before their Products. Match that order
      // even when an edit resubmits the Product's current Brand.
      const resolvedBrandId =
        productData.brandId === undefined
          ? undefined
          : await resolveProductBrand(tx, productData.brandId);
      await lockExternalIdentifierParents(tx, [
        { entityId: id, entityKind: "product" },
      ]);
      const beforeProduct = await tx.query.product.findFirst({
        where: and(eq(product.id, id), notDeleted(product)),
      });

      if (!beforeProduct) {
        throw createAppError("PRODUCT_NOT_FOUND", `Product ${id} not found`);
      }

      const identifiersRequested =
        externalIdsInput !== undefined || data.barcode !== undefined;
      const beforeExternalIds =
        readOutput && !classificationRequested
          ? []
          : await tx.query.entityExternalId.findMany({
              where: and(
                eq(entityExternalId.entityId, id),
                notDeleted(entityExternalId),
              ),
            });

      const { desiredExternalIds, incomingGtin, updateData } =
        await prepareUpdate(
          tx,
          beforeProduct,
          beforeExternalIds,
          resolvedBrandId,
        );

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
        await validateLiveInheritedPolicies(tx, { kind: "product", ids: [id] });

      // Conversion coverage and inventory valuation are invalidated only after
      // mappings land; both are projections of the resulting conversion graph.
      await syncProductUpdateDependents(tx, incomingGtin, desiredExternalIds);
      const admittedCategoryId = classificationRequested
        ? await assertProductCategoryChange(tx, id, updated.categoryId)
        : updated.categoryId;
      if (admittedCategoryId !== updated.categoryId)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Product classification conflicts with its identity evidence.",
        );
      const galleryRequested = [
        pendingImageIds,
        pendingImagePurposes,
        removeImageIds,
        imageOrder,
      ].some((value) => value !== undefined);
      const beforeGallery = galleryRequested
        ? await productGallerySnapshot(tx, id)
        : [];
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
      const productImages =
        !readOutput || galleryRequested
          ? await tx.query.entityAttachment.findMany({
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
            })
          : [];

      const currentExternalIdRows =
        !readOutput || identifiersRequested
          ? await tx.query.entityExternalId.findMany({
              where: and(
                eq(entityExternalId.entityId, updated.id),
                notDeleted(entityExternalId),
              ),
            })
          : beforeExternalIds;

      const scalarChanges = computeChanges(
        { ...beforeProduct, externalIds: beforeExternalIds },
        { ...updated, externalIds: currentExternalIdRows },
        [...entityFieldModels.product.audit],
      );
      const changes = galleryRequested
        ? {
            ...scalarChanges,
            ...productGalleryIntent(beforeGallery, productImages),
          }
        : scalarChanges;

      if (changes) {
        await logAuditEntry(tx, actor, {
          entityKind: "product",
          entityId: updated.id,
          action: "update",
          changes,
        });
      }

      await recordChange(tx, { kind: "source", categories: ["product"] });

      if (readOutput) return readOutput(tx, updated);
      return readWrittenProduct(tx, updated.id);
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
}

type ExternalIdRow = typeof entityExternalId.$inferSelect;
type ExternalIdPatchItem = ExternalIdPatch[number];

/** Source slugs lowercase; barcodes in their one canonical GTIN-14 form. */
const normalizedExternalIdPatch = (patch: ExternalIdPatch) =>
  patch.map((item) => ({
    ...item,
    key: {
      ...item.key,
      source: item.key.source.trim().toLowerCase(),
      externalId:
        item.key.kind === GTIN_KIND
          ? requireCanonicalGtin(item.key.externalId)
          : item.key.externalId,
    },
  }));

const liveExternalIdRow = (
  rows: readonly ExternalIdRow[],
  key: ExternalIdPatchItem["key"],
) =>
  rows.find(
    (row) =>
      row.source === key.source &&
      row.kind === key.kind &&
      row.externalId === key.externalId,
  );

/** Every remove/replace names a live identifier holding what `expect` says. */
const assertExternalIdPatchPreconditions = (
  rows: readonly ExternalIdRow[],
  items: readonly ExternalIdPatchItem[],
) => {
  for (const item of items) {
    if (item.op === "add") continue;
    const { source, kind, externalId } = item.key;
    const row = liveExternalIdRow(rows, item.key);
    const inSlot = rows.filter(
      (candidate) => candidate.source === source && candidate.kind === kind,
    );
    if (!row)
      throw createAppError(
        "PRODUCT_EXTERNAL_ID_PRECONDITION_FAILED",
        inSlot.length > 0
          ? `Product external ID ${source}/${kind} holds ${inSlot
              .map((candidate) => candidate.externalId)
              .join(", ")}, not the expected ${externalId}.`
          : `Product has no live external ID in slot ${source}/${kind}.`,
      );
    const expected = item.expect;
    const primaryDiffers =
      expected?.isPrimary !== undefined && expected.isPrimary !== row.isPrimary;
    const urlDiffers =
      expected?.url !== undefined && (expected.url ?? null) !== row.url;
    if (primaryDiffers || urlDiffers)
      throw createAppError(
        "PRODUCT_EXTERNAL_ID_PRECONDITION_FAILED",
        `Product external ID ${source}/${kind}/${externalId} is ${row.isPrimary ? "primary" : "secondary"} with url ${row.url ?? "none"}, not the expected ${JSON.stringify(expected)}.`,
      );
  }
};

// Demote BEFORE promoting or inserting: the one-primary partial unique is a
// plain non-deferrable index, so two primaries may never coexist.
const demoteSlotPrimary = (
  tx: DrizzleTransaction,
  id: ProductId,
  source: string,
  kind: ExternalIdKind,
) =>
  tx
    .update(entityExternalId)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(entityExternalId.entityId, id),
        eq(entityExternalId.source, source),
        eq(entityExternalId.kind, kind),
        eq(entityExternalId.isPrimary, true),
        notDeleted(entityExternalId),
      ),
    );

/** `replace`: change a live identifier's url and/or primary flag in place. */
const replaceExternalIdAttributes = async (
  tx: DrizzleTransaction,
  id: ProductId,
  row: ExternalIdRow,
  item: Extract<ExternalIdPatchItem, { op: "replace" }>,
) => {
  if (item.value.isPrimary === true && !row.isPrimary)
    await demoteSlotPrimary(tx, id, item.key.source, item.key.kind);
  await tx
    .update(entityExternalId)
    .set({
      isPrimary: item.value.isPrimary ?? row.isPrimary,
      url:
        item.value.url === undefined
          ? row.url
          : storedExternalIdUrl({ ...item.key, url: item.value.url }),
      updatedAt: new Date(),
    })
    .where(eq(entityExternalId.id, row.id));
};

/** Add learns one identity; only explicit primary intent changes another row's role. */
const addExternalIdToSlot = async (
  tx: DrizzleTransaction,
  id: ProductId,
  item: Extract<ExternalIdPatchItem, { op: "add" }>,
) => {
  const { source, kind, externalId } = item.key;
  const slotRows = await tx.query.entityExternalId.findMany({
    where: and(
      eq(entityExternalId.entityId, id),
      eq(entityExternalId.source, source),
      eq(entityExternalId.kind, kind),
      notDeleted(entityExternalId),
    ),
  });
  const sameValue = slotRows.find((row) => row.externalId === externalId);
  const isPrimary =
    item.value?.isPrimary ??
    sameValue?.isPrimary ??
    !slotRows.some((row) => row.isPrimary);
  const url =
    item.value?.url === undefined
      ? (sameValue?.url ?? null)
      : storedExternalIdUrl({ ...item.key, url: item.value.url });
  if (sameValue && sameValue.isPrimary === isPrimary && sameValue.url === url)
    return;
  if (isPrimary && !sameValue?.isPrimary)
    await demoteSlotPrimary(tx, id, source, kind);
  if (sameValue) {
    await tx
      .update(entityExternalId)
      .set({ url, isPrimary, updatedAt: new Date() })
      .where(eq(entityExternalId.id, sameValue.id));
  } else {
    await tx.insert(entityExternalId).values({
      entityId: id,
      entityKind: "product",
      source,
      kind,
      externalId,
      url,
      isPrimary,
    });
  }
};

/**
 * The Product repository's `externalIds` collection hook: applies
 * `entity.update` patch items (`externalIdPatch`) inside the update's
 * transaction. Every remove/replace precondition is checked against the live
 * rows before any row changes; global uniqueness is checked before any add.
 * The one-primary-per-slot repair (`ensureSlotPrimaries`) runs last, so
 * removing or demoting a primary promotes the slot's oldest survivor.
 */
const applyProductExternalIdPatch = async (
  tx: DrizzleTransaction,
  id: ProductId,
  patch: ExternalIdPatch,
): Promise<void> => {
  await lockExternalIdentifierParents(tx, [
    { entityId: id, entityKind: "product" },
  ]);
  const items = normalizedExternalIdPatch(patch);
  const before = await tx.query.entityExternalId.findMany({
    where: and(eq(entityExternalId.entityId, id), notDeleted(entityExternalId)),
  });
  assertExternalIdPatchPreconditions(before, items);
  const adds = items.flatMap((item) => (item.op === "add" ? [item] : []));
  await assertExternalIdsAvailable(
    tx,
    adds.map((item) => item.key),
    id,
  );
  await ensureExternalSources(
    tx,
    adds.map((item) => item.key.source),
  );

  for (const item of items) {
    if (item.op !== "remove") continue;
    await tx
      .update(entityExternalId)
      .set({ deletedAt: new Date() })
      .where(eq(entityExternalId.id, liveExternalIdRow(before, item.key)!.id));
  }
  for (const item of items) {
    if (item.op !== "replace") continue;
    await replaceExternalIdAttributes(
      tx,
      id,
      liveExternalIdRow(before, item.key)!,
      item,
    );
  }
  for (const item of adds) await addExternalIdToSlot(tx, id, item);
  // Restore the one-primary-per-slot invariant after every write. See
  // `ensureSlotPrimaries` for why this is a repair keyed on live state rather
  // than promotion logic inside the loops.
  await ensureSlotPrimaries(
    tx,
    id,
    items.map((item) => item.key),
  );
};

/** The entry shortcut uses the same atomic collection mutation as explicit edits. */
const applyPrimaryBarcode = async (
  tx: DrizzleTransaction,
  id: ProductId,
  value: string | null,
) => {
  const primary =
    value === null
      ? await tx.query.entityExternalId.findFirst({
          where: and(
            eq(entityExternalId.entityId, id),
            eq(entityExternalId.source, GTIN_SOURCE),
            eq(entityExternalId.kind, GTIN_KIND),
            eq(entityExternalId.isPrimary, true),
            notDeleted(entityExternalId),
          ),
          columns: { externalId: true },
        })
      : undefined;
  const patch: ExternalIdPatch =
    value !== null
      ? [
          {
            op: "add",
            key: { source: GTIN_SOURCE, kind: GTIN_KIND, externalId: value },
            value: { isPrimary: true },
          },
        ]
      : primary
        ? [
            {
              op: "remove",
              key: {
                source: GTIN_SOURCE,
                kind: GTIN_KIND,
                externalId: primary.externalId,
              },
            },
          ]
        : [];
  if (patch.length) await applyProductExternalIdPatch(tx, id, patch);
};

interface QuickCreateProductInput {
  name: string;
  brandId?: import("@cubby/schemas/identifiers").VendorShortcode | null;
  barcode?: string | null;
  expectedQuantity?: number | null;
  model?: string | null;
  fdc_id?: number | null;
  ingredientId?: IngredientId | null;
  price?: number | null;
  categoryId?: ProductCategoryId | null;
  shortcode?: string; // Optional shortcode from import (preserves sheet shortcodes)
  createdAt?: Date;
  updatedAt?: Date;
}

export const quickCreateProduct = async (
  db: Database,
  data: QuickCreateProductInput,
  actor: ActorContext,
): Promise<RawProductOutput> =>
  (await quickCreateProductRecord(db, data, actor)).output;

/** `quickCreateProduct` with the inserted row's id, so a caller never re-resolves the code it just minted. */
export const quickCreateProductRecord = async (
  db: Database,
  data: QuickCreateProductInput,
  actor: ActorContext,
): Promise<{ output: RawProductOutput; entityId: ProductId }> => {
  const incomingGtin = resolvePrimaryProductCodeInput(data.barcode);
  const categoryId = await resolveProductCategory(
    db,
    data.categoryId ?? null,
    impliedProductFeature({
      fdc_id: data.fdc_id,
      ingredientId: data.ingredientId,
      hasIsbn:
        incomingGtin != null &&
        externalIdsContainIsbn([
          { source: GTIN_SOURCE, externalId: incomingGtin },
        ]),
    }),
  );

  const values = {
    name: data.name,
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
  const { newProduct } = await withTransaction(db, async (tx) => {
    const brandId = await resolveProductBrand(tx, data.brandId);
    const productValues = { ...values, brandId };
    // An explicit `shortcode` only comes from the import/restore path, which is
    // replaying a code that already exists; everything else mints one through
    // `insertWithShortcode` so it gets the collision retry.
    const inserted = data.shortcode
      ? await insertPayloadWithIdentity(tx, product, "product", {
          ...productValues,
          shortcode: data.shortcode,
        })
      : await insertWithShortcode(tx, "product", productValues);

    if (incomingGtin != null) {
      await applyPrimaryBarcode(tx, inserted.id, incomingGtin);
    }

    await logAuditEntry(tx, actor, {
      entityKind: "product",
      entityId: inserted.id,
      action: "create",
    });

    return { newProduct: inserted };
  });

  const output = await readWrittenProduct(db, newProduct.id);
  return { output, entityId: newProduct.id };
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
  "ImportSourceProduct.productId": (tx, ids) =>
    tx
      .select({ productId: importSourceProduct.productId })
      .from(importSourceProduct)
      .where(inArray(importSourceProduct.productId, ids)),
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
      beforeDelete: (tx, ids) =>
        lockExternalIdentifierParents(
          tx,
          ids.map((entityId) => ({ entityId, entityKind: "product" })),
        ),
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
