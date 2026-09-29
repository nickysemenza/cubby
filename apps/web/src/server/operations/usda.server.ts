import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import type { z } from "zod";

import {
  type usdaProductSuggestionsOut,
  usdaFoodContract,
} from "~/contracts/usda.contract";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { foodLookupParamFromProduct } from "~/server/repo/product";
import { getProductUsdaSuggestionSource } from "~/server/repo/product/usda-suggestion-source";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import type { USDAService } from "~/server/services/usda.service";

const products = bindShortcodeResolver("product");

export type UsdaSuggestionPort = Pick<USDAService, "findFood" | "listFoods">;
type UsdaProductSuggestions = z.output<typeof usdaProductSuggestionsOut>;

const SUGGESTIONS_PER_QUERY = 5;

/**
 * USDA foods that plausibly describe one Product, best evidence first: an
 * exact barcode hit (each of its barcodes, primary first), then a search on
 * name + manufacturer, then — only when that finds nothing — the bare name.
 * A food is listed once, under its strongest reason. Advisory: it never
 * writes the link (`fdc_id` stays the caller's deliberate choice).
 */
export async function suggestUsdaFoodsForProduct(
  { db, usdaService }: { db: Database; usdaService: UsdaSuggestionPort },
  productCode: string,
): Promise<UsdaProductSuggestions> {
  const source = await getProductUsdaSuggestionSource(
    db,
    await products.one(db, productCode),
  );
  if (!source)
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `Product not found: ${productCode}`,
    );
  const candidates: UsdaProductSuggestions["candidates"] = [];
  const seen = new Set<number>();
  const add = (
    reason: UsdaProductSuggestions["candidates"][number]["reason"],
    foods: UsdaProductSuggestions["candidates"][number]["food"][],
  ) => {
    for (const food of foods) {
      if (seen.has(food.fdc_id)) continue;
      seen.add(food.fdc_id);
      candidates.push({ reason, food });
    }
  };

  for (const gtin of source.gtins) {
    const lookup = foodLookupParamFromProduct({
      primaryGtin: gtin,
      fdc_id: null,
    });
    if (!lookup) continue;
    const found = await usdaService.findFood(lookup);
    if (found) add("upc", [found]);
  }

  const search = async (query: string) =>
    (
      await usdaService.listFoods(
        query,
        undefined,
        { orderBy: "relevance", direction: "asc" },
        { pageIndex: 0, pageSize: SUGGESTIONS_PER_QUERY },
        true,
      )
    ).data;
  const qualified = isUnspecifiedManufacturer(source.manufacturer)
    ? []
    : await search(`${source.name} ${source.manufacturer}`);
  add("name_manufacturer", qualified);
  if (qualified.length === 0) add("name", await search(source.name));

  return { currentFdcId: source.fdc_id, candidates };
}

export const usdaFoodHandlers = implementOperationDomain(usdaFoodContract, {
  list: async (context, input) => {
    const { data, count } = await context.usdaService.listFoods(
      input.filters.nameFilter,
      input.filters.dataTypeFilter,
      normalizeSorts(input.sort)[0]!,
      input.pagination,
      input.filters.foodsOnly,
      input.filters.dataTypes,
      input.filters.linkedProductsOnly,
    );
    return buildPaginatedResponse(input.pagination, data, count);
  },
  detail: (context, input) => context.usdaService.getFoodSummaryByID(input.id),
  alternateId: (context, input) => context.usdaService.findFood(input),
  search: async (context, input) => {
    const pagination = {
      pageIndex: input.pageIndex,
      pageSize: input.pageSize,
    };
    const { data, count } = await context.usdaService.listFoods(
      input.query,
      input.dataType,
      { orderBy: "relevance", direction: "asc" },
      pagination,
      true,
    );
    return buildPaginatedResponse(pagination, data, count);
  },
  byFdcId: async (context, input) => ({
    food: await context.usdaService.getFoodSummaryByID(input.fdcId),
  }),
  suggestForProduct: (context, input) =>
    suggestUsdaFoodsForProduct(context, input.productId),
  find: async (context, input) => ({
    food: await context.usdaService.findFood(
      input.upc !== undefined
        ? { kind: "upc", gtin_upc: input.upc }
        : { kind: "ndb", ndb_number: requiredNdb(input.ndbNumber) },
    ),
  }),
});

/** The input refinement guarantees exactly one of `upc` / `ndbNumber`. */
function requiredNdb<T>(ndbNumber: T | undefined): T {
  if (ndbNumber === undefined)
    throw new Error("Validated USDA lookup input is incomplete");
  return ndbNumber;
}
