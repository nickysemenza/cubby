/**
 * Service for AI-powered enrichment of locations and inventory.
 *
 * Handles multi-step orchestration: fetching images, calling Anthropic, persisting results.
 */

import type { Confidence, LocationDescription } from "@cubby/schemas/ai";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { IngredientId, LocationId } from "@cubby/schemas/identifiers";
import { type DataType, dataTypeEnum } from "@cubby/usda-schemas";
import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { searchIngredientsForMerge } from "~/server/repo/ingredient";
import { getInventoryByLocationIds } from "~/server/repo/inventory";
import {
  findLocationsNeedingAiDescription,
  getLocationById,
  updateLocationAiDescription,
} from "~/server/repo/location";
import type { USDAService } from "~/server/services/usda.service";

// Defined by Vite for the Cloudflare build only; guard before reading (mirrors
// db.ts). Used only as a "prod"/"dev" label for AI Gateway metadata here.
declare const __CF_WORKERS__: boolean | undefined;
const IS_CF_WORKERS =
  typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

// Drive a chat() loop to completion. Tool handlers capture results via closures,
// so we only watch for run errors here: chat() delivers provider/transport
// failures as a RUN_ERROR chunk rather than throwing, and an unsurfaced one looks
// like "no match" to the caller. Shared by both search-then-select flows below.
async function drainChat(
  stream: AsyncIterable<unknown>,
  label: string,
): Promise<void> {
  for await (const chunk of stream) {
    const type = (chunk as { type?: string })?.type ?? "";
    if (type.includes("ERROR")) {
      console.error(
        `[${label}] run error:`,
        (chunk as { message?: string }).message ?? JSON.stringify(chunk),
      );
    }
  }
}

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

interface UsdaFoodSuggestion {
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
  const adapter = getAnthropicClient().getTextAdapter({
    feature: "usda-food-suggest",
    ingredient: ingredientName,
    env: IS_CF_WORKERS ? "prod" : "dev",
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

  // Run one USDA search: list, record every result in `seenFoods` (so a later
  // select can return the full record and reject ids never seen), and format it
  // for the model. Shared by the search tool and the up-front pre-seed below.
  const runSearch = async (
    query: string,
    dataType?: DataType,
  ): Promise<string> => {
    const { data } = await usdaService.listFoods(
      query,
      dataType,
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
  };

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
    return runSearch(args.query, args.dataType);
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

  // Pre-seed the first search server-side and hand the model the results in the
  // opening message, so it can usually select on turn 1 instead of spending a
  // round-trip issuing the obvious name search itself (search_usda_foods stays
  // available for refinement). Cuts the common path from ~3 model turns to ~1.
  const initialResults = await runSearch(ingredientName);

  const stream = chat({
    adapter,
    systemPrompts: [buildUsdaMatchPrompt()],
    messages: [
      {
        role: "user",
        content: `Find the best USDA food for the recipe ingredient: "${ingredientName}".

Initial search results for "${ingredientName}":
${initialResults}

If one is a clearly correct generic match, call select_food now. Otherwise refine with search_usda_foods first, then call select_food.`,
      },
    ],
    tools: [searchTool, selectTool],
    agentLoopStrategy: maxIterations(6),
  });
  await drainChat(stream, "suggestUsdaFood");

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

/** One batch entry: the input name plus its suggestion (food null = no match). */
interface UsdaFoodBatchSuggestion extends UsdaFoodSuggestion {
  name: string;
}

/**
 * Batch {@link suggestUsdaFood} for the enrichment workbench's "Suggest USDA for
 * selected" action. Read-only — returns one suggestion per name for the user to
 * review and commit; it never links anything. Each name is its own agent loop
 * (several USDA searches), so concurrency is bounded and the batch is capped.
 */
export async function suggestUsdaFoodBatch(
  usdaService: USDAService,
  names: string[],
): Promise<UsdaFoodBatchSuggestion[]> {
  const capped = names.slice(0, 20);
  const out: UsdaFoodBatchSuggestion[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((name) => suggestUsdaFood(usdaService, name)),
    );
    results.forEach((result, j) => {
      const name = batch[j] as string;
      if (result.status === "fulfilled") {
        out.push({ name, ...result.value });
      } else {
        console.error(`[suggestUsdaFoodBatch] ${name} failed:`, result.reason);
        out.push({
          name,
          food: null,
          confidence: "low",
          reasoning: "Lookup failed.",
        });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI-assisted ingredient merge suggestions
//
// EPUB imports create near-duplicate ingredients that string matching can't
// catch (scallion≈green onion, cilantro≈coriander, garbanzo≈chickpea). Same
// agentic loop as the USDA matcher: a search tool over existing ingredients + a
// terminal select tool, with a `seen` map so the model can only target an id it
// actually saw. Suggestions only — merge is destructive, so the user confirms.
// ---------------------------------------------------------------------------

interface IngredientMergeSuggestion {
  target: { id: IngredientId; name: string } | null;
  confidence: Confidence;
  reasoning: string;
}

function buildMergePrompt(): string {
  return `You decide whether a recipe ingredient is the SAME purchasable item as an existing ingredient, so the two can be merged (deduplicated).

Merge ONLY when they are the same thing you would buy — synonyms, alternate names, or spelling/case variants. Examples to merge: scallion = green onion; cilantro = coriander (leaf); garbanzo beans = chickpeas; confectioners' sugar = powdered sugar.

NEVER merge distinct variants a cook treats differently: light vs dark brown sugar; whole vs 2% milk; salted vs unsalted butter; fresh vs dried herbs.

Tools:
- search_ingredients(query): existing ingredients by name, as "id [N products]: name". Prefer a target that already has products — the merge inherits them.
- select_merge_target(ingredientId, confidence, reasoning): your decision. ingredientId must be an id from a search result, or null if there is no genuine duplicate. Call exactly once.

Default to null when unsure. A wrong merge is destructive, so be conservative.`;
}

/**
 * Suggest an existing ingredient to merge a bare/imported one into. Read-only —
 * returns a candidate (or null) for the user to confirm; merges nothing.
 */
async function suggestIngredientMerge(
  db: Database,
  source: { id: IngredientId; name: string },
): Promise<IngredientMergeSuggestion> {
  const adapter = getAnthropicClient().getTextAdapter({
    feature: "ingredient-merge",
    ingredient: source.name,
    env: IS_CF_WORKERS ? "prod" : "dev",
  });

  const seen = new Map<string, { id: IngredientId; name: string }>();
  const state: {
    selection: {
      ingredientId: string | null;
      confidence: Confidence;
      reasoning: string;
    } | null;
  } = { selection: null };

  // Run one ingredient search: record every hit in `seen` (so a later select can
  // only target an id the model actually saw) and format for the model. Shared
  // by the search tool and the up-front pre-seed below.
  const runSearch = async (query: string): Promise<string> => {
    const rows = await searchIngredientsForMerge(db, query, source.id, 12);
    for (const r of rows) seen.set(r.id, { id: r.id, name: r.name });
    if (rows.length === 0) return "No results.";
    return rows
      .map((r) => `${r.id} [${r.productCount} products]: ${r.name}`)
      .join("\n");
  };

  const searchTool = toolDefinition({
    name: "search_ingredients",
    description:
      "Search existing ingredients by name. Returns up to 12 candidates as `id [N products]: name`.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Name to search" } },
      required: ["query"],
    },
  }).server(async (rawArgs) => {
    const args = (rawArgs ?? {}) as { query?: string };
    if (!args.query) return "Provide a query.";
    return runSearch(args.query);
  });

  const selectTool = toolDefinition({
    name: "select_merge_target",
    description:
      "Record your decision. Call exactly once. ingredientId must come from a search result, or null if there is no genuine duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        ingredientId: { type: ["string", "null"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        reasoning: { type: "string" },
      },
      required: ["ingredientId", "confidence", "reasoning"],
    },
  }).server(async (rawArgs) => {
    const args = (rawArgs ?? {}) as {
      ingredientId?: string | null;
      confidence?: Confidence;
      reasoning?: string;
    };
    state.selection = {
      ingredientId: args.ingredientId ?? null,
      confidence: args.confidence ?? "low",
      reasoning: args.reasoning ?? "",
    };
    return "Recorded.";
  });

  // Pre-seed the obvious name search server-side so the model can decide on turn
  // 1 in the common case (search_ingredients stays available to refine).
  const initialResults = await runSearch(source.name);

  const stream = chat({
    adapter,
    systemPrompts: [buildMergePrompt()],
    messages: [
      {
        role: "user",
        content: `Is the recipe ingredient "${source.name}" the same purchasable item as an existing ingredient?

Existing ingredients matching "${source.name}":
${initialResults}

If one is a genuine duplicate, call select_merge_target now. Otherwise search_ingredients to look wider, then call select_merge_target (null if there is no real duplicate).`,
      },
    ],
    tools: [searchTool, selectTool],
    agentLoopStrategy: maxIterations(6),
  });
  await drainChat(stream, "suggestIngredientMerge");

  const { selection } = state;
  if (!selection || selection.ingredientId == null) {
    return {
      target: null,
      confidence: selection?.confidence ?? "low",
      reasoning: selection?.reasoning || "No duplicate found.",
    };
  }
  // Only honor an id the model actually saw (anti-hallucination).
  return {
    target: seen.get(selection.ingredientId) ?? null,
    confidence: selection.confidence,
    reasoning: selection.reasoning,
  };
}

interface IngredientMergeBatchSuggestion extends IngredientMergeSuggestion {
  source: { id: IngredientId; name: string };
}

/** Batch {@link suggestIngredientMerge} for the workbench's "Suggest merges". */
export async function suggestIngredientMergeBatch(
  db: Database,
  sources: { id: IngredientId; name: string }[],
): Promise<IngredientMergeBatchSuggestion[]> {
  const capped = sources.slice(0, 20);
  const out: IngredientMergeBatchSuggestion[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((s) => suggestIngredientMerge(db, s)),
    );
    results.forEach((result, j) => {
      const source = batch[j] as { id: IngredientId; name: string };
      if (result.status === "fulfilled") {
        out.push({ source, ...result.value });
      } else {
        console.error(
          `[suggestIngredientMergeBatch] ${source.name} failed:`,
          result.reason,
        );
        out.push({
          source,
          target: null,
          confidence: "low",
          reasoning: "Lookup failed.",
        });
      }
    });
  }
  return out;
}
