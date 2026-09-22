import { entityRefKey } from "@cubby/schemas/entity";
import type { LocationId } from "@cubby/schemas/identifiers";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { parseShortcode } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import { uniq } from "es-toolkit";

import { startOperationDefinition } from "~/lib/start-operation-observability";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { observeOperationPhase } from "~/server/observed-request";
import { loadDataQualities } from "~/server/repo/data-quality";
import { getDb, notDeleted, relations } from "~/server/repo/database-helpers";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { loadImageAnalysisSummaries } from "~/server/repo/image-analysis-summary";
import { getRecipeUsagesForIngredient } from "~/server/repo/ingredient";
import { loadLocationAncestorsWithIds } from "~/server/repo/location/tree";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product/crud";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import {
  dbProductToAPI,
  primaryGtinOf,
  productImageShortcodesOf,
} from "~/server/repo/product/mappers";
import { enrichProductRowsWithPricing } from "~/server/repo/product/pricing";
import {
  EMPTY_QUANTITY_LEDGER,
  loadProductDetailQuantityLedgers,
} from "~/server/repo/product/quantity-ledger";
import type { ProductDeepDB } from "~/server/repo/product/types";

interface ProductDetailReadContext {
  db: Database;
  usdaClient: USDAClient;
}

const PRODUCT_DETAIL_OPERATION = startOperationDefinition("entity.detail");

/** Resolve the relation data needed by Product location rows without N+1 walks. */
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

const emptyRecipeUsages = {
  recipeUsages: [],
  appearsInRecipes: [],
};

/**
 * The Product detail read model. The shortcode lookup, local projections,
 * quality evidence, breadcrumbs, USDA lookup, and recipe usages all live behind
 * this small seam so callers cannot accidentally reorder or omit a detail phase.
 */
export async function readProductDetail(
  context: ProductDetailReadContext,
  shortcode: string,
): Promise<ProductWithFoodOut | null> {
  const parsed = parseShortcode(shortcode);
  if (parsed?.type !== "product") return null;

  const row = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "base",
    () =>
      getDb(context.db).query.product.findFirst({
        where: and(
          eq(product.shortcode, parsed.shortcode),
          notDeleted(product),
        ),
        ...relations.product.full,
      }),
  );
  if (!row) return null;

  // These reads all depend only on the base row's ids/relations. Starting USDA
  // before the local projections hides external latency behind the local DB
  // work; the local phases retain their existing aggregate and breadcrumb rules.
  const foodPromise = observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "food",
    () => {
      const lookupParam = foodLookupParamFromProduct({
        primaryGtin: primaryGtinOf(row.externalIds),
        fdc_id: row.fdc_id,
      });
      return lookupParam
        ? context.usdaClient.findFood(lookupParam)
        : Promise.resolve(null);
    },
  );
  const pricing = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "pricing",
    async () => {
      const priced = await enrichProductRowsWithPricing(context.db, [row]);
      const pricing = priced[0]?.pricing;
      if (!pricing)
        throw new Error("Product pricing enrichment omitted its row");
      return pricing;
    },
  );
  const quantityLedger = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "quantity",
    async () => {
      const quantities = await loadProductDetailQuantityLedgers(context.db, [
        row.id,
      ]);
      return quantities.get(row.id) ?? EMPTY_QUANTITY_LEDGER;
    },
  );
  const breadcrumbed = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "breadcrumbs",
    () =>
      hydrateProductLocationBreadcrumbs(context.db, [
        { ...row, quantityLedger },
      ]).then((rows) => rows[0]!),
  );
  const dataQuality = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "quality",
    async () => {
      const quality = (
        await loadDataQualities(context.db, "product", [row.id])
      ).get(row.id);
      if (!quality)
        throw new Error(`Data quality was not loaded for product ${row.id}`);
      return quality;
    },
  );
  // Not wrapped in `observeOperationPhase`: the tracked phase vocabulary for
  // "entity.detail" is a closed list (`entity-detail.functions.ts`) this repo
  // module doesn't own, so this batched lookup rides alongside the "quality"
  // phase's timing instead of minting a new one.
  const coverImageUrl =
    (await getProductCoverImageUrlsByProductIds(context.db, [row.id])).get(
      row.id,
    ) ?? null;
  const analysisSummaries = await loadImageAnalysisSummaries(
    context.db,
    productImageShortcodesOf(breadcrumbed.images),
  );
  const recipe = await observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "recipe_usages",
    () =>
      row.ingredient?.deletedAt === null
        ? getRecipeUsagesForIngredient(context.db, row.ingredient.id)
        : Promise.resolve(emptyRecipeUsages),
  );
  const food = await foodPromise;

  const mapped = dbProductToAPI(
    {
      ...breadcrumbed,
      pricing,
      quantityLedger,
      coverImageUrl,
    },
    dataQuality,
    analysisSummaries,
  );
  return {
    ...mapped,
    food,
    recipeUsages: recipe.recipeUsages,
  };
}
