// AI-assisted USDA food matching
//
// Cookbook ingredients ("AP flour", "orange juice") rarely match the USDA
// description verbatim, and raw name-search is dominated by branded products.
// `usda-shortlist.ts` assembles a shortlist from a handful of WASM-derived
// query variants; this asks the decision tier to pick exactly one candidate
// in a single call via `runAiSelection` (no agentic search loop).

import type { Confidence } from "@cubby/schemas/ai";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";

import { runAiSelection } from "~/server/ai/selection";
import type { Database } from "~/server/db";

import {
  buildUsdaShortlist,
  usdaFoodSpec,
  type UsdaLookupPort,
  type UsdaShortlistEntry,
} from "./usda-shortlist";

export type { UsdaLookupPort } from "./usda-shortlist";

export interface UsdaMatchAiPort {
  select: typeof runAiSelection<UsdaShortlistEntry>;
}

const productionUsdaMatchAiPort: UsdaMatchAiPort = { select: runAiSelection };

export interface UsdaFoodSuggestion {
  food: FoodSummaryWithLinkedProducts | null;
  confidence: Confidence;
  reasoning: string;
}

/**
 * Shortlist USDA foods ourselves ({@link buildUsdaShortlist}), then ask the
 * decision tier to pick exactly one in a single call. Returns the
 * full chosen food (with inferred unit mappings) so callers can link it
 * without a re-fetch, or null when nothing fits.
 */
export async function suggestUsdaFood(
  usdaService: UsdaLookupPort,
  db: Database,
  ingredientName: string,
  opts: { ingredientId?: IngredientId } = {},
  ai: UsdaMatchAiPort = productionUsdaMatchAiPort,
): Promise<UsdaFoodSuggestion> {
  const shortlist = await buildUsdaShortlist(usdaService, ingredientName);
  if (shortlist.length === 0) {
    return {
      food: null,
      confidence: "low",
      reasoning: "No USDA candidates found.",
    };
  }

  const { selected, confidence, reasoning } = await ai.select(usdaFoodSpec, {
    subject: `Find the best USDA food for the recipe ingredient: "${ingredientName}".`,
    candidates: shortlist,
    usage: {
      db,
      operation: "suggestUsdaFood",
      cacheStatus: "none",
      entity: opts.ingredientId
        ? { entityType: "ingredient", entityId: opts.ingredientId }
        : null,
    },
  });

  if (!selected) {
    return {
      food: null,
      confidence,
      reasoning: reasoning || "No suitable match found.",
    };
  }
  return { food: selected.food, confidence, reasoning };
}

/** One batch entry: the input name plus its suggestion (food null = no match). */
interface UsdaFoodBatchSuggestion extends UsdaFoodSuggestion {
  name: string;
}

export interface UsdaMatchPorts<TDatabase> {
  suggest: (
    service: UsdaLookupPort,
    database: TDatabase,
    name: string,
    options?: { ingredientId?: IngredientId },
  ) => Promise<UsdaFoodSuggestion>;
}

const productionUsdaMatchPorts: UsdaMatchPorts<Database> = {
  suggest: suggestUsdaFood,
};

/**
 * Batch {@link suggestUsdaFood} for the enrichment workbench's "Suggest USDA for
 * selected" action. Read-only — returns one suggestion per name for the user to
 * review and commit; it never links anything. Each name is its own shortlist +
 * select call, so concurrency is bounded and the batch is capped.
 *
 * A per-item `Promise.allSettled` rejection is an infrastructure failure
 * (network blip, AI gateway hiccup) — indistinguishable, to this function's
 * caller, from "the model genuinely found no match". The degraded
 * `{food: null, reasoning: "Lookup failed."}` entry still returns immediately
 * so the batch doesn't stall and the item is reported as a failed row in the
 * result rather than silently treated as "no match".
 */
async function suggestUsdaFoodBatchWithPorts<TDatabase>(
  usdaService: UsdaLookupPort,
  db: TDatabase,
  ingredients: { id: IngredientId; name: string }[],
  ports: UsdaMatchPorts<TDatabase>,
): Promise<UsdaFoodBatchSuggestion[]> {
  const capped = ingredients.slice(0, 20);
  const out: UsdaFoodBatchSuggestion[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((item) =>
        ports.suggest(usdaService, db, item.name, { ingredientId: item.id }),
      ),
    );
    for (const [j, result] of results.entries()) {
      const item = batch[j]!;
      if (result.status === "fulfilled") {
        out.push({ name: item.name, ...result.value });
      } else {
        console.error(
          `[suggestUsdaFoodBatch] ${item.name} failed:`,
          result.reason,
        );
        out.push({
          name: item.name,
          food: null,
          confidence: "low",
          reasoning: "Lookup failed.",
        });
      }
    }
  }

  return out;
}

export function createUsdaMatchService<TDatabase>(
  ports: UsdaMatchPorts<TDatabase>,
) {
  return {
    suggestUsdaFoodBatch: (
      service: UsdaLookupPort,
      database: TDatabase,
      ingredients: { id: IngredientId; name: string }[],
    ) => suggestUsdaFoodBatchWithPorts(service, database, ingredients, ports),
  };
}

const productionUsdaMatch = createUsdaMatchService(productionUsdaMatchPorts);
export const suggestUsdaFoodBatch = productionUsdaMatch.suggestUsdaFoodBatch;
