// AI-assisted USDA food matching
//
// Cookbook ingredients ("AP flour", "orange juice") rarely match the USDA
// description verbatim, and raw name-search is dominated by branded products.
// Instead of a fixed query set, we give gpt-4o-mini a search tool and let it
// drive its own (refined, generic-biased) queries, then commit a choice via a
// terminal select tool. Same @tanstack/ai loop the agent runtime uses.

import type { Confidence } from "@cubby/schemas/ai";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { type DataType, dataTypeEnum } from "@cubby/usda-schemas";
import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import { DEFAULT_CHAT_MODEL } from "~/server/ai/models";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import { aiGatewayUsageMiddleware } from "~/server/clients/ai-gateway-usage";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { getIngredientByID } from "~/server/repo/ingredient";
import type { USDAService } from "~/server/services/usda.service";

import { drainChat, IS_CF_WORKERS } from "./shared";

export interface UsdaMatchAiPort {
  getTextAdapter: ReturnType<typeof getAnthropicClient>["getTextAdapter"];
}

const productionUsdaMatchAiPort: UsdaMatchAiPort = {
  getTextAdapter: (...args) => getAnthropicClient().getTextAdapter(...args),
};

export interface UsdaFoodSuggestion {
  food: FoodSummaryWithLinkedProducts | null;
  confidence: Confidence;
  reasoning: string;
}

interface UsdaFoodSelection {
  fdcId: number | null;
  confidence: Confidence;
  reasoning: string;
}

interface UsdaSelectionState {
  selection: UsdaFoodSelection | null;
}

const searchToolArgumentsSchema = z.object({
  query: z.string().min(1),
  dataType: dataTypeEnum.optional(),
});

const selectToolArgumentsSchema = z.object({
  fdcId: z.number().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
});

export interface UsdaLookupPort {
  listFoods: USDAService["listFoods"];
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
  usdaService: UsdaLookupPort,
  db: Database,
  ingredientName: string,
  opts: { ingredientId?: IngredientId } = {},
  ai: UsdaMatchAiPort = productionUsdaMatchAiPort,
): Promise<UsdaFoodSuggestion> {
  const adapter = ai.getTextAdapter({
    feature: "usda-food-suggest",
    ingredient: ingredientName,
    env: IS_CF_WORKERS ? "prod" : "dev",
  });

  // Every food the model sees across searches, so we can return the full record
  // for whichever fdcId it selects (and reject ids it never actually saw).
  const seenFoods = new Map<number, FoodSummaryWithLinkedProducts>();
  // Holder object (not a bare `let`) so TS keeps the declared type after the
  // closure assignment instead of narrowing it away.
  const state: UsdaSelectionState = { selection: null };

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
    const parsed = searchToolArgumentsSchema.safeParse(rawArgs);
    if (!parsed.success) return "Provide a query.";
    const { query, dataType } = parsed.data;
    return runSearch(query, dataType);
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
    const parsed = selectToolArgumentsSchema.safeParse(rawArgs);
    if (!parsed.success) return "Provide a complete selection.";
    const args = parsed.data;
    state.selection = {
      fdcId: args.fdcId,
      confidence: args.confidence,
      reasoning: args.reasoning,
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
    middleware: aiGatewayUsageMiddleware({
      db,
      feature: "usda-food-suggest",
      provider: "anthropic",
      model: DEFAULT_CHAT_MODEL,
      operation: "suggestUsdaFood",
      cacheStatus: "none",
      entity: opts.ingredientId
        ? { entityType: "ingredient", entityId: opts.ingredientId }
        : null,
    }),
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

export interface UsdaMatchPorts<TDatabase> {
  dispatchRetries: (
    database: TDatabase,
    input: Parameters<typeof dispatchBackgroundJobs>[1],
  ) => Promise<void>;
  getIngredient: (
    database: TDatabase,
    id: IngredientId,
  ) => Promise<{ name: string }>;
  suggest: (
    service: UsdaLookupPort,
    database: TDatabase,
    name: string,
    options?: { ingredientId?: IngredientId },
  ) => Promise<UsdaFoodSuggestion>;
  servicesForRetry: (
    database: TDatabase,
  ) => Promise<{ usdaService: UsdaLookupPort }>;
}

const productionUsdaMatchPorts: UsdaMatchPorts<Database> = {
  dispatchRetries: async (database, input) => {
    await dispatchBackgroundJobs(database, input);
  },
  getIngredient: getIngredientByID,
  suggest: suggestUsdaFood,
  servicesForRetry: async (database) => {
    const { buildCrudServices } = await import("~/server/request-context");
    return buildCrudServices(database);
  },
};

/**
 * Batch {@link suggestUsdaFood} for the enrichment workbench's "Suggest USDA for
 * selected" action. Read-only — returns one suggestion per name for the user to
 * review and commit; it never links anything. Each name is its own agent loop
 * (several USDA searches), so concurrency is bounded and the batch is capped.
 *
 * A per-item `Promise.allSettled` rejection is an infrastructure failure
 * (network blip, AI gateway hiccup) — indistinguishable, to this function's
 * caller, from "the model genuinely found no match". The degraded
 * `{food: null, reasoning: "Lookup failed."}` entry still returns immediately
 * so the batch doesn't stall, but the failure ALSO dispatches a
 * `usda-match.retry` background job for that ingredient, so the queue's own
 * backoff/attempts absorb a transient blip instead of the human having to
 * notice a "Lookup failed" row and manually retry (Tenet 3: this is exactly
 * the unattended-retry work the queue exists for, unlike the interactive
 * search loop above it).
 */
async function suggestUsdaFoodBatchWithPorts<TDatabase>(
  usdaService: UsdaLookupPort,
  db: TDatabase,
  ingredients: { id: IngredientId; name: string }[],
  ports: UsdaMatchPorts<TDatabase>,
): Promise<UsdaFoodBatchSuggestion[]> {
  const capped = ingredients.slice(0, 20);
  const out: UsdaFoodBatchSuggestion[] = [];
  const failed: { id: IngredientId; name: string }[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((item) => ports.suggest(usdaService, db, item.name)),
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
        failed.push(item);
      }
    }
  }

  // Retry scheduling is deliberately BEST-EFFORT and happens after the read
  // loop, never inside it. Two reasons, both learned the hard way:
  //
  //  1. `out` already holds every degraded and matched entry by this point. An
  //     unguarded `await dispatchBackgroundJobs(...)` inside the loop meant a
  //     rejecting dispatch (DB insert, queue.sendBatch) threw straight out of
  //     this function and discarded ALL of them — turning "some matched, some
  //     degraded" into a total failure, the exact opposite of the degrade
  //     path's purpose.
  //  2. With no queue bound (dev, test, self-host), `dispatchBackgroundJobs`
  //     falls through to `processInlineJobs`, which loops
  //     `while (outcome === "retry")` with no backoff and no bound. Dispatching
  //     per failed item ran a full extra agent lookup, synchronously, inside
  //     the user's request — once per failure, precisely during the upstream
  //     outage that caused the failures. One dispatch of N jobs replaces N
  //     dispatches, and the try/catch keeps a queue problem from ever reaching
  //     the caller.
  if (failed.length > 0) {
    try {
      await ports.dispatchRetries(db, {
        kind: "usda-match.retry",
        source: "mutation",
        jobs: failed.map((item) => ({
          kind: "usda-match.retry" as const,
          dedupeKey: `usda-match.retry:${item.id}`,
          payload: { ingredientId: item.id },
        })),
      });
    } catch (error) {
      console.error(
        "[suggestUsdaFoodBatch] could not schedule retries:",
        getErrorMessage(error),
      );
    }
  }

  return out;
}

/**
 * Background-job retry for a `suggestUsdaFoodBatch` item that failed at the
 * infra level (see that function's doc comment). Re-fetches the ingredient's
 * current name — the dispatching batch may be stale by the time this job
 * runs — and re-attempts the single-item lookup directly, bypassing
 * `suggestUsdaFoodBatch`'s swallow-and-degrade catch so a real failure here
 * throws and lets `processBackgroundJob`'s retry/backoff take over.
 *
 * Deliberately read-only, same as `suggestUsdaFood` itself: it does not set
 * `product.usdaUnavailable` (that column is a human's "I checked, no USDA
 * food exists" assertion — conflating it with an automated retry, successful
 * or not, would misrepresent what a person decided) and does not link a
 * product to this food. Tenet 2's `ingredient → product → fdc_id` commit
 * stays a deliberate, reviewed write in the interactive workbench; a
 * successful retry's only visible effect is the job finishing "succeeded"
 * rather than "failed", confirming the transient failure has cleared.
 */
async function retryUsdaMatchWithPorts<TDatabase>(
  db: TDatabase,
  ingredientId: IngredientId,
  ports: UsdaMatchPorts<TDatabase>,
): Promise<void> {
  const { usdaService } = await ports.servicesForRetry(db);
  const ingredient = await ports.getIngredient(db, ingredientId);
  await ports.suggest(usdaService, db, ingredient.name, { ingredientId });
}

export function createUsdaMatchService<TDatabase>(
  ports: UsdaMatchPorts<TDatabase>,
) {
  return {
    retryUsdaMatch: (database: TDatabase, ingredientId: IngredientId) =>
      retryUsdaMatchWithPorts(database, ingredientId, ports),
    suggestUsdaFoodBatch: (
      service: UsdaLookupPort,
      database: TDatabase,
      ingredients: { id: IngredientId; name: string }[],
    ) => suggestUsdaFoodBatchWithPorts(service, database, ingredients, ports),
  };
}

const productionUsdaMatch = createUsdaMatchService(productionUsdaMatchPorts);
export const retryUsdaMatch = productionUsdaMatch.retryUsdaMatch;
export const suggestUsdaFoodBatch = productionUsdaMatch.suggestUsdaFoodBatch;
