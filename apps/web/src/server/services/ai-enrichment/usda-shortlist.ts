import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { type DataType } from "@cubby/usda-schemas";

import { wasm } from "~/lib/wasm";
/**
 * USDA shortlist assembly for the AI food matcher.
 *
 * Cookbook ingredients ("AP flour", "orange juice") rarely match the USDA
 * description verbatim, and a single raw name-search is dominated by branded
 * products. Instead of letting the model drive its own agentic search loop,
 * this runs a handful of query variants derived from the WASM ingredient
 * grammar (never a hand-listed vocabulary — see
 * docs: size-unit-vocabulary-derives-from-wasm) up front, merges the results,
 * and hands the model one shortlist to pick from.
 */
import { USDA_FOOD_SUGGEST_FEATURE } from "~/server/ai/features";
import type { AiSelectionSpec } from "~/server/ai/selection";
import type { USDAService } from "~/server/services/usda.service";

export interface UsdaLookupPort {
  listFoods: USDAService["listFoods"];
}

export interface UsdaShortlistEntry {
  fdcId: number;
  line: string;
  food: FoodSummaryWithLinkedProducts;
}

/**
 * Query variants to search USDA with, in preference order: the ingredient
 * name verbatim, the WASM parser's cleaned-up name (strips amount/modifier),
 * and the head noun of the parser's own "name" segments (its last
 * whitespace-delimited token) — never a hand-listed synonym table. Trimmed,
 * empties dropped, deduped case-insensitively; the head noun is dropped
 * outright when it is 2 characters or shorter (too short to search on).
 */
export function usdaQueryVariants(name: string): string[] {
  const parsedName = wasm.parse_ingredient(name).name;
  const { segments } = wasm.decompose_ingredient(name);
  const nameText = segments
    .filter((segment) => segment.field === "name")
    .map((segment) => segment.text)
    .join(" ")
    .trim();
  const headNoun = nameText.split(/\s+/).filter(Boolean).at(-1) ?? "";

  const candidates: (string | null)[] = [
    name,
    parsedName,
    headNoun.length > 2 ? headNoun : null,
  ];

  const seen = new Set<string>();
  const variants: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(trimmed);
  }
  return variants;
}

/** One search config per {@link usdaQueryVariants} slot, in order. */
const VARIANT_SEARCH_SPECS: {
  dataType: DataType | undefined;
  pageSize: number;
}[] = [
  { dataType: "sr_legacy_food", pageSize: 15 },
  { dataType: undefined, pageSize: 15 },
  { dataType: "sr_legacy_food", pageSize: 10 },
];

/** A product can only link a food by NDB number or UPC. */
function isLinkable(food: FoodSummaryWithLinkedProducts): boolean {
  return (
    food.legacyFoodInfo?.ndb_number != null || !!food.brandedFoodInfo?.gtin_upc
  );
}

function formatShortlistLine(food: FoodSummaryWithLinkedProducts): string {
  const brand = food.brandedFoodInfo?.brand_owner
    ? `, ${food.brandedFoodInfo.brand_owner}`
    : "";
  return `FDC ${food.fdc_id} [${food.foodInfo.data_type}${brand}]: ${food.foodInfo.description}`;
}

/**
 * Run every {@link usdaQueryVariants} search concurrently, merge the results
 * in variant order (a variant missing because it deduped away is simply
 * skipped), dedupe by `fdc_id`, drop foods Cubby cannot link, and cap at
 * `limit`. The model picks from a closed set, so an unlinkable food must
 * never be a choice — filtering here is the only way to enforce that.
 */
export async function buildUsdaShortlist(
  usdaService: UsdaLookupPort,
  name: string,
  limit = 25,
): Promise<UsdaShortlistEntry[]> {
  const variants = usdaQueryVariants(name);
  const perVariant = await Promise.all(
    variants.map((query, index) => {
      const spec = VARIANT_SEARCH_SPECS[index];
      return usdaService.listFoods(
        query,
        spec?.dataType,
        { orderBy: "fdc_id", direction: "asc" },
        { pageIndex: 0, pageSize: spec?.pageSize ?? 15 },
      );
    }),
  );

  const byId = new Map<number, UsdaShortlistEntry>();
  for (const { data } of perVariant) {
    for (const food of data) {
      if (byId.has(food.fdc_id) || !isLinkable(food)) continue;
      byId.set(food.fdc_id, {
        fdcId: food.fdc_id,
        line: formatShortlistLine(food),
        food,
      });
    }
  }
  return [...byId.values()].slice(0, limit);
}

const USDA_MATCH_RULES = `You map a recipe ingredient to the single best USDA FoodData Central entry, for nutrition and cost.

Rules:
1. Prefer the generic whole-food form. Prefer sr_legacy_food over foundation_food.
2. Choose a branded_food ONLY when the ingredient is itself a brand/specific product (e.g. "Biscoff cookies", "Oreos").
3. Decline if nothing suitable is shown.`;

export const usdaFoodSpec: AiSelectionSpec<UsdaShortlistEntry> = {
  feature: USDA_FOOD_SUGGEST_FEATURE,
  rules: USDA_MATCH_RULES,
  idOf: (entry) => String(entry.fdcId),
  renderLine: (entry) => entry.line,
  maxCandidates: 25,
};
