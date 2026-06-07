/**
 * Service for AI-powered enrichment of locations and inventory.
 *
 * Handles multi-step orchestration: fetching images, calling Anthropic, persisting results.
 */

import type { Confidence, LocationDescription } from "@cubby/schemas/ai";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { LocationId } from "@cubby/schemas/identifiers";
import { type DataType, dataTypeEnum } from "@cubby/usda-schemas";
import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import { getAnthropicClient } from "~/server/clients/anthropic";
import { getGatewayOpenAIAdapter } from "~/server/clients/openai";
import type { Database } from "~/server/db";
import { getInventoryByLocationIds } from "~/server/repo/inventory";
import {
  findLocationsNeedingAiDescription,
  getLocationById,
  updateLocationAiDescription,
} from "~/server/repo/location";
import type { USDAService } from "~/server/services/usda.service";

// Defined by Vite for the Cloudflare build only; guard before reading (mirrors db.ts).
declare const __CF_WORKERS__: boolean | undefined;

/**
 * Analyze location photos and generate a description of contents.
 * Persists the description to the location record.
 */
export async function describeLocation(
  db: Database,
  locationId: LocationId,
): Promise<LocationDescription> {
  const location = await getLocationById(db, locationId);

  const imageUrls = location.images?.map((img) => img.url) ?? [];
  if (imageUrls.length === 0) {
    throw new Error("Location has no images to analyze");
  }

  const client = getAnthropicClient();
  const result = await client.describeLocation(
    imageUrls.slice(0, 5),
    location.name,
  );

  await updateLocationAiDescription(db, locationId, result.description);

  return result;
}

/**
 * Detect inventory items from location photos.
 * Returns detected items for user review — does not persist anything.
 */
export async function detectInventoryItems(
  db: Database,
  locationId: LocationId,
) {
  const location = await getLocationById(db, locationId);

  const imageUrls = location.images?.map((img) => img.url) ?? [];
  if (imageUrls.length === 0) {
    throw new Error("Location has no images to analyze");
  }

  // Get existing inventory item names to avoid duplicates
  const existingInventory = await getInventoryByLocationIds(db, [locationId]);
  const existingItemNames = existingInventory.map(
    (entry) => entry.product.name,
  );

  const client = getAnthropicClient();
  return client.detectInventoryItems(
    imageUrls.slice(0, 5),
    location.name,
    existingItemNames,
  );
}

/**
 * Backfill AI descriptions for all locations that have images but no description.
 * Processes in batches of 10 for throughput while limiting concurrency.
 */
export async function backfillLocationDescriptions(
  db: Database,
): Promise<{ analyzed: number; total: number }> {
  const client = getAnthropicClient();
  const locations = await findLocationsNeedingAiDescription(db);

  let analyzed = 0;
  for (let i = 0; i < locations.length; i += 10) {
    const batch = locations.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (loc) => {
        const result = await client.describeLocation(
          loc.imageUrls.slice(0, 5),
          loc.name,
        );
        await updateLocationAiDescription(db, loc.id, result.description);
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        analyzed++;
      } else {
        console.error("Failed to describe location:", result.reason);
      }
    }
  }

  return { analyzed, total: locations.length };
}

// ---------------------------------------------------------------------------
// AI-assisted USDA food matching
//
// Cookbook ingredients ("AP flour", "orange juice") rarely match the USDA
// description verbatim, and raw name-search is dominated by branded products.
// Instead of a fixed query set, we give gpt-4o-mini a search tool and let it
// drive its own (refined, generic-biased) queries, then commit a choice via a
// terminal select tool. Same @tanstack/ai loop the agent runtime uses.
// ---------------------------------------------------------------------------

export interface UsdaFoodSuggestion {
  food: FoodSummaryWithLinkedProducts | null;
  confidence: Confidence;
  reasoning: string;
}

function buildUsdaMatchPrompt(): string {
  return `You map a recipe ingredient to the single best USDA FoodData Central entry, for nutrition and cost.

Tools:
- search_usda_foods(query, dataType?): search by name. Call it as many times as needed, refining the query (e.g. "AP flour" -> "wheat flour all purpose"). dataType "foundation_food" and "sr_legacy_food" are GENERIC whole foods; "branded_food" is a specific store product.
- select_food(fdcId, confidence, reasoning): record your final answer. Call exactly once at the end.

Rules:
1. Prefer the generic whole-food form. Each result is tagged "id=ok" (has an NDB number or UPC, so it can be linked) or "id=none". You MUST select a food tagged "id=ok" — a food with no id cannot be linked. sr_legacy_food entries have NDB numbers; foundation_food entries usually do NOT, so prefer sr_legacy_food over foundation_food. Bias your searches with dataType=sr_legacy_food for generic ingredients.
2. Choose a branded_food ONLY when the ingredient is itself a brand/specific product (e.g. "Biscoff cookies", "Oreos").
3. fdcId MUST be one you saw in a search result AND tagged "id=ok". If nothing suitable is found, call select_food with fdcId=null.
4. Keep reasoning to one sentence. Do not write any other prose.`;
}

/**
 * Agentic USDA matcher: the model searches USDA itself, then selects an fdcId.
 * Returns the full chosen food (with inferred unit mappings) so callers can link
 * it without a re-fetch, or null when nothing fits.
 */
export async function suggestUsdaFood(
  usdaService: USDAService,
  ingredientName: string,
): Promise<UsdaFoodSuggestion> {
  const isProd =
    typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;
  const adapter = getGatewayOpenAIAdapter({
    feature: "usda-food-suggest",
    ingredient: ingredientName,
    env: isProd ? "prod" : "dev",
  });

  // Every food the model sees across searches, so we can return the full record
  // for whichever fdcId it selects (and reject ids it never actually saw).
  const seenFoods = new Map<number, FoodSummaryWithLinkedProducts>();
  // Holder object (not a bare `let`) so TS keeps the declared type after the
  // closure assignment instead of narrowing it away.
  const state: {
    selection: {
      fdcId: number | null;
      confidence: Confidence;
      reasoning: string;
    } | null;
  } = { selection: null };

  const searchTool = toolDefinition({
    name: "search_usda_foods",
    description:
      "Search USDA FoodData Central by name. foundation_food & sr_legacy_food are generic whole foods; branded_food is specific products. Returns up to 15 candidates.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Food name to search for" },
        dataType: {
          type: "string",
          enum: [...dataTypeEnum.options],
          description: "Optional bias toward a USDA data type",
        },
      },
      required: ["query"],
    },
  }).server(async (rawArgs) => {
    const args = (rawArgs ?? {}) as { query?: string; dataType?: DataType };
    if (!args.query) return "Provide a query.";
    const { data } = await usdaService.listFoods(
      args.query,
      args.dataType,
      { orderBy: "fdc_id", direction: "asc" },
      { pageIndex: 0, pageSize: 15 },
    );
    for (const food of data) seenFoods.set(food.fdc_id, food);
    if (data.length === 0) return "No results.";
    return data
      .map((f) => {
        // A product can only link a food by NDB or UPC, so flag linkable foods.
        const linkable =
          f.legacyFoodInfo?.ndb_number != null || !!f.brandedFoodInfo?.gtin_upc;
        const brand = f.brandedFoodInfo?.brand_owner
          ? `, ${f.brandedFoodInfo.brand_owner}`
          : "";
        return `FDC ${f.fdc_id} [${f.foodInfo.data_type}${brand}, id=${
          linkable ? "ok" : "none"
        }]: ${f.foodInfo.description}`;
      })
      .join("\n");
  });

  const selectTool = toolDefinition({
    name: "select_food",
    description:
      "Record your final choice. Call exactly once. fdcId must come from a prior search result, or null if nothing fits.",
    inputSchema: {
      type: "object",
      properties: {
        fdcId: { type: ["number", "null"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        reasoning: { type: "string" },
      },
      required: ["fdcId", "confidence", "reasoning"],
    },
  }).server(async (rawArgs) => {
    const args = (rawArgs ?? {}) as {
      fdcId?: number | null;
      confidence?: Confidence;
      reasoning?: string;
    };
    state.selection = {
      fdcId: args.fdcId ?? null,
      confidence: args.confidence ?? "low",
      reasoning: args.reasoning ?? "",
    };
    return "Recorded.";
  });

  const stream = chat({
    adapter,
    systemPrompts: [buildUsdaMatchPrompt()],
    messages: [
      {
        role: "user",
        content: `Find the best USDA food for the recipe ingredient: "${ingredientName}". Search as needed, then call select_food.`,
      },
    ],
    tools: [searchTool, selectTool],
    agentLoopStrategy: maxIterations(6),
  });
  // Drive the loop to completion; tool handlers capture state via closures.
  // chat() delivers provider/transport failures as a RUN_ERROR chunk rather than
  // throwing, so surface those (otherwise a failed call looks like "no match").
  for await (const chunk of stream) {
    const type = (chunk as { type?: string })?.type ?? "";
    if (type.includes("ERROR")) {
      console.error(
        "[suggestUsdaFood] run error:",
        (chunk as { message?: string }).message ?? JSON.stringify(chunk),
      );
    }
  }

  const { selection } = state;
  if (!selection || selection.fdcId == null) {
    return {
      food: null,
      confidence: selection?.confidence ?? "low",
      reasoning: selection?.reasoning || "No suitable match found.",
    };
  }
  // Guard hallucinated ids: only honor an fdcId the model actually saw.
  return {
    food: seenFoods.get(selection.fdcId) ?? null,
    confidence: selection.confidence,
    reasoning: selection.reasoning,
  };
}
