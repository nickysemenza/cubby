import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { parseShortcode } from "@cubby/shared";
import { and, eq } from "drizzle-orm";

import { startOperationDefinition } from "~/lib/start-operation-observability";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { observeOperationPhase } from "~/server/observed-request";
import { loadDataQualities } from "~/server/repo/data-quality";
import { getDb, notDeleted, relations } from "~/server/repo/database-helpers";
import { loadImageAnalysisSummaries } from "~/server/repo/image-analysis-summary";
import { getRecipeUsagesForIngredient } from "~/server/repo/ingredient";
import { enrichProductRowsWithInventoryValuations } from "~/server/repo/inventory/valuation";
import {
  getProductCoverImageUrlsByProductIds,
  hydrateProductLocationBreadcrumbs,
} from "~/server/repo/product/crud";
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

import { loadProductOwnershipEvidence } from "./ownership-evidence";

interface ProductDetailReadContext {
  db: Database;
  usdaClient: USDAClient;
}

const PRODUCT_DETAIL_OPERATION = startOperationDefinition("entity.detail");

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
  const ownershipPromise = loadProductOwnershipEvidence(context.db, row.id);
  const pricingPromise = observeOperationPhase(
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
  const quantityPromise = observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "quantity",
    async () => {
      const quantities = await loadProductDetailQuantityLedgers(context.db, [
        row.id,
      ]);
      return quantities.get(row.id) ?? EMPTY_QUANTITY_LEDGER;
    },
  );
  const breadcrumbPromise = observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "breadcrumbs",
    async () => {
      const [valued, quantityLedger] = await Promise.all([
        enrichProductRowsWithInventoryValuations(context.db, [row]),
        quantityPromise,
      ]);
      const rows = await hydrateProductLocationBreadcrumbs(context.db, [
        { ...valued[0]!, quantityLedger },
      ]);
      return rows[0]!;
    },
  );
  const dataQualityPromise = observeOperationPhase(
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
  // "entity.detail" is a closed list (`entity-detail.ts`) this repo
  // module doesn't own, so this batched lookup rides alongside the "quality"
  // phase's timing instead of minting a new one.
  const coverPromise = getProductCoverImageUrlsByProductIds(context.db, [
    row.id,
  ]);
  const analysisPromise = breadcrumbPromise.then((breadcrumbed) =>
    loadImageAnalysisSummaries(
      context.db,
      productImageShortcodesOf(breadcrumbed.images),
    ),
  );
  const recipePromise = observeOperationPhase(
    PRODUCT_DETAIL_OPERATION,
    "recipe_usages",
    () =>
      row.ingredient?.deletedAt === null
        ? getRecipeUsagesForIngredient(context.db, row.ingredient.id)
        : Promise.resolve(emptyRecipeUsages),
  );
  const [
    pricing,
    quantityLedger,
    breadcrumbed,
    dataQuality,
    covers,
    analysisSummaries,
    recipe,
    food,
    ownership,
  ] = await Promise.all([
    pricingPromise,
    quantityPromise,
    breadcrumbPromise,
    dataQualityPromise,
    coverPromise,
    analysisPromise,
    recipePromise,
    foodPromise,
    ownershipPromise,
  ]);
  const coverImageUrl = covers.get(row.id) ?? null;

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
    ownershipEvidence: ownership,
    food,
    recipeUsages: recipe.recipeUsages,
  };
}
