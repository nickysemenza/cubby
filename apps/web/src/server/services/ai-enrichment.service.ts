/**
 * Service for AI-powered enrichment of locations and inventory.
 *
 * Handles multi-step orchestration: fetching images, calling Anthropic, persisting results.
 */

import type {
  ApproveDetectedInventoryItemInput,
  ApproveDetectedInventoryItemOut,
  Confidence,
  DetectedInventory,
  DetectedInventoryAiResult,
  DetectedInventoryItem,
  DetectedItem,
  LocationDescription,
} from "@cubby/schemas/ai";
import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type IngredientId,
  type LocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import { type ProductCategory, productCategory } from "@cubby/schemas/product";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import { type DataType, dataTypeEnum } from "@cubby/usda-schemas";
import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import {
  buildLocationAnalysisFingerprint,
  LOCATION_DESCRIPTION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
} from "~/server/ai/features";
import { DEFAULT_CHAT_MODEL } from "~/server/ai/models";
import { dispatchBackgroundJobs } from "~/server/background-queue";
import { aiGatewayUsageMiddleware } from "~/server/clients/ai-gateway-usage";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  getCachedAiAnalysis,
  upsertAiAnalysis,
} from "~/server/repo/ai-analysis";
import { recordAiUsage } from "~/server/repo/ai-usage";
import { searchIngredientsForMerge } from "~/server/repo/ingredient";
import {
  createInventoryEntry,
  getInventoryByLocationIds,
} from "~/server/repo/inventory";
import {
  findLocationsNeedingAiDescription,
  getLocationById,
  updateLocationAiDescription,
} from "~/server/repo/location";
import {
  findProductByNameFuzzyManufacturer,
  getProductByID,
  quickCreateProduct,
} from "~/server/repo/product";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";
import type { USDAService } from "~/server/services/usda.service";

// Defined by Vite for the Cloudflare build only; guard before reading (mirrors
// db.ts). Used only as a "prod"/"dev" label for AI Gateway metadata here.
declare const __CF_WORKERS__: boolean | undefined;
const IS_CF_WORKERS =
  typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

const MAX_ANALYSIS_IMAGES = 5;
const SEMANTIC_PRODUCT_MATCH_THRESHOLD = 0.86;
const LOCATION_NO_IMAGES_MESSAGE = "Location has no images to analyze";

class LocationHasNoImagesToAnalyzeError extends Error {
  constructor() {
    super(LOCATION_NO_IMAGES_MESSAGE);
    this.name = "LocationHasNoImagesToAnalyzeError";
  }
}

export function isLocationHasNoImagesToAnalyzeError(
  error: unknown,
): error is LocationHasNoImagesToAnalyzeError {
  return (
    error instanceof LocationHasNoImagesToAnalyzeError ||
    (error instanceof Error && error.message === LOCATION_NO_IMAGES_MESSAGE)
  );
}

interface DetectedProductMatch {
  id: ReturnType<typeof unsafeProductId>;
  name: string;
  manufacturer: string;
  category: ProductCategory | null;
}

function itemProductName(item: DetectedInventoryItem): string {
  if (item.isMisc && !isMiscProduct(item.name)) {
    return `misc: ${item.name}`;
  }
  return item.name;
}

function normalizedProductName(name: string): string {
  return getMiscDisplayName(name).trim().toLowerCase();
}

const INVENTORY_NAME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "general",
  "purpose",
  "the",
]);

function inventoryNameTokens(name: string): Set<string> {
  const normalized = normalizedProductName(name)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !INVENTORY_NAME_STOPWORDS.has(token))
    .map((token) =>
      token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token,
    );
  return new Set(normalized);
}

export function isDetectedItemCoveredByInventoryName(
  detectedName: string,
  inventoryName: string,
): boolean {
  const detectedTokens = inventoryNameTokens(detectedName);
  const inventoryTokens = inventoryNameTokens(inventoryName);

  if (detectedTokens.size < 2 || inventoryTokens.size < 2) return false;

  let shared = 0;
  for (const token of detectedTokens) {
    if (inventoryTokens.has(token)) shared++;
  }

  return shared === detectedTokens.size;
}

function cacheMetadata(
  status: "hit" | "miss",
  feature: typeof LOCATION_DESCRIPTION_FEATURE,
  inputFingerprint: string,
) {
  return {
    status,
    feature: feature.feature,
    model: feature.model,
    promptVersion: feature.promptVersion,
    inputFingerprint,
  };
}

function detectionCacheMetadata(
  status: "hit" | "miss",
  inputFingerprint: string,
) {
  return {
    status,
    feature: LOCATION_INVENTORY_DETECTION_FEATURE.feature,
    model: LOCATION_INVENTORY_DETECTION_FEATURE.model,
    promptVersion: LOCATION_INVENTORY_DETECTION_FEATURE.promptVersion,
    inputFingerprint,
  };
}

async function recordLocationAiUsage(
  db: Database,
  input: {
    feature:
      | typeof LOCATION_DESCRIPTION_FEATURE
      | typeof LOCATION_INVENTORY_DETECTION_FEATURE;
    operation: string;
    cacheStatus: "hit" | "miss";
    durationMs: number;
    locationId: LocationId;
    batchId?: string;
  },
): Promise<void> {
  await recordAiUsage(db, {
    feature: input.feature.feature,
    provider: "anthropic",
    model: input.feature.model,
    operation: input.operation,
    inputTokens: null,
    outputTokens: null,
    durationMs: input.durationMs,
    cacheStatus: input.cacheStatus,
    entity: { entityType: "location", entityId: input.locationId },
    batchId: input.batchId,
  });
}

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
  opts: { batchId?: string } = {},
): Promise<LocationDescription> {
  const location = await getLocationById(db, locationId);

  const images = (location.images ?? []).slice(0, MAX_ANALYSIS_IMAGES);
  if (images.length === 0) {
    throw new LocationHasNoImagesToAnalyzeError();
  }

  const inputFingerprint = buildLocationAnalysisFingerprint(
    LOCATION_DESCRIPTION_FEATURE,
    { locationName: location.name, images },
  );
  const analysisKey = {
    entityType: "location" as const,
    entityId: locationId,
    feature: LOCATION_DESCRIPTION_FEATURE,
    inputFingerprint,
  };
  const cached = await getCachedAiAnalysis(db, analysisKey);
  if (cached) {
    console.info("ai.analysis", {
      ...cacheMetadata("hit", LOCATION_DESCRIPTION_FEATURE, inputFingerprint),
      entityType: "location",
      entityId: locationId,
    });
    if (location.aiDescription !== cached.description) {
      await updateLocationAiDescription(db, locationId, cached.description);
      await runMutationSideEffects(db, {
        action: "updated",
        entity: { entityType: "location", entityId: locationId },
        source: "location-ai.description",
      });
    }
    await recordLocationAiUsage(db, {
      feature: LOCATION_DESCRIPTION_FEATURE,
      operation: "locationDescription",
      cacheStatus: "hit",
      durationMs: 0,
      locationId,
      batchId: opts.batchId,
    });
    return cached;
  }

  const client = getAnthropicClient();
  const result = await client.describeLocation(
    images.map((img) => img.url),
    location.name,
    {
      db,
      feature: LOCATION_DESCRIPTION_FEATURE.feature,
      model: LOCATION_DESCRIPTION_FEATURE.model,
      operation: "locationDescription",
      cacheStatus: "miss",
      entity: { entityType: "location", entityId: locationId },
      batchId: opts.batchId,
    },
  );
  await upsertAiAnalysis(db, analysisKey, result);
  console.info("ai.analysis", {
    ...cacheMetadata("miss", LOCATION_DESCRIPTION_FEATURE, inputFingerprint),
    entityType: "location",
    entityId: locationId,
  });

  await updateLocationAiDescription(db, locationId, result.description);
  await runMutationSideEffects(db, {
    action: "updated",
    entity: { entityType: "location", entityId: locationId },
    source: "location-ai.description",
  });

  return result;
}

async function matchDetectedItems(
  db: Database,
  locationId: LocationId,
  items: DetectedInventoryItem[],
): Promise<DetectedItem[]> {
  const existingInventory = await getInventoryByLocationIds(db, [locationId]);
  const existingProductIds = new Set(
    existingInventory.map((entry) => entry.product.id),
  );
  const existingNames = new Set(
    existingInventory.map((entry) => normalizedProductName(entry.product.name)),
  );
  const existingInventoryNames = existingInventory.map(
    (entry) => entry.product.name,
  );

  const suggestions: DetectedItem[] = [];
  for (const item of items) {
    const productName = itemProductName(item);
    if (existingNames.has(normalizedProductName(productName))) continue;
    if (
      existingInventoryNames.some((existingName) =>
        isDetectedItemCoveredByInventoryName(productName, existingName),
      )
    ) {
      continue;
    }

    const exactMatched = await findProductByNameFuzzyManufacturer(
      db,
      productName,
      item.manufacturer,
    );
    let matched: DetectedProductMatch | null = exactMatched
      ? {
          id: exactMatched.id,
          name: exactMatched.name,
          manufacturer: exactMatched.manufacturer,
          category: exactMatched.category,
        }
      : null;
    if (!matched) {
      const [semanticMatch] = await semanticProductCandidatesBestEffort(
        db,
        productName,
      );
      if (
        semanticMatch &&
        semanticMatch.similarity >= SEMANTIC_PRODUCT_MATCH_THRESHOLD &&
        semanticMatch.item.entityType === "product" &&
        !existingProductIds.has(unsafeProductId(semanticMatch.item.id))
      ) {
        matched = {
          id: unsafeProductId(semanticMatch.item.id),
          name: semanticMatch.item.name,
          manufacturer: semanticMatch.item.subtitle ?? item.manufacturer,
          category:
            productCategory.safeParse(semanticMatch.item.typeHint).data ?? null,
        };
      }
    }
    if (matched && existingProductIds.has(matched.id)) continue;

    suggestions.push({
      ...item,
      name: productName,
      matchedProduct: matched
        ? {
            id: matched.id,
            name: matched.name,
            manufacturer: matched.manufacturer,
            category: matched.category,
          }
        : null,
    });
  }
  return suggestions;
}

async function semanticProductCandidatesBestEffort(
  db: Database,
  query: string,
): ReturnType<typeof semanticProductCandidates> {
  try {
    return await semanticProductCandidates(db, query, 3);
  } catch (error) {
    console.warn("ai.inventory.semantic-product-match.failed", {
      query,
      errorName: error instanceof Error ? error.name : typeof error,
      message: getErrorMessage(error),
    });
    return [];
  }
}

/**
 * Detect inventory items from location photos.
 * Returns detected items for user review — does not persist anything.
 */
export async function detectInventoryItems(
  db: Database,
  locationId: LocationId,
  opts: { batchId?: string } = {},
): Promise<DetectedInventory> {
  const location = await getLocationById(db, locationId);

  const images = (location.images ?? []).slice(0, MAX_ANALYSIS_IMAGES);
  if (images.length === 0) {
    throw new LocationHasNoImagesToAnalyzeError();
  }

  const inputFingerprint = buildLocationAnalysisFingerprint(
    LOCATION_INVENTORY_DETECTION_FEATURE,
    { locationName: location.name, images },
  );
  const analysisKey = {
    entityType: "location" as const,
    entityId: locationId,
    feature: LOCATION_INVENTORY_DETECTION_FEATURE,
    inputFingerprint,
  };
  const cached = await getCachedAiAnalysis(db, analysisKey);
  const cacheStatus = cached ? "hit" : "miss";
  let raw: DetectedInventoryAiResult;

  if (cached) {
    raw = cached;
    await recordLocationAiUsage(db, {
      feature: LOCATION_INVENTORY_DETECTION_FEATURE,
      operation: "locationInventoryDetection",
      cacheStatus: "hit",
      durationMs: 0,
      locationId,
      batchId: opts.batchId,
    });
  } else {
    const client = getAnthropicClient();
    raw = await client.detectInventoryItems(
      images.map((img) => img.url),
      location.name,
      {
        db,
        feature: LOCATION_INVENTORY_DETECTION_FEATURE.feature,
        model: LOCATION_INVENTORY_DETECTION_FEATURE.model,
        operation: "locationInventoryDetection",
        cacheStatus: "miss",
        entity: { entityType: "location", entityId: locationId },
        batchId: opts.batchId,
      },
    );
    await upsertAiAnalysis(db, analysisKey, raw);
  }

  const cache = detectionCacheMetadata(cacheStatus, inputFingerprint);
  console.info("ai.analysis", {
    ...cache,
    entityType: "location",
    entityId: locationId,
  });

  return {
    ...raw,
    items: await matchDetectedItems(db, locationId, raw.items),
    cache,
  };
}

export async function approveDetectedInventoryItem(
  db: Database,
  input: ApproveDetectedInventoryItemInput,
  actor: ActorContext,
): Promise<ApproveDetectedInventoryItemOut> {
  const productName = itemProductName(input.item);
  const existingInventory = await getInventoryByLocationIds(db, [
    input.locationId,
  ]);

  let productId = input.productId ?? null;
  let productNameForToast = productName;
  let createdProduct = false;
  const backgroundBatches: BackgroundBatchRef[] = [];

  if (productId) {
    const product = await getProductByID(db, productId);
    productNameForToast = product.name;
  } else {
    const matched = await findProductByNameFuzzyManufacturer(
      db,
      productName,
      input.item.manufacturer,
    );
    if (matched) {
      productId = matched.id;
      productNameForToast = matched.name;
    } else {
      const created = await quickCreateProduct(
        db,
        {
          name: productName,
          manufacturer: input.item.manufacturer,
          category: input.item.category,
        },
        actor,
      );
      productId = created.id;
      productNameForToast = created.name;
      createdProduct = true;
      backgroundBatches.push(
        ...(await runMutationSideEffects(db, {
          action: "created",
          entity: { entityType: "product", entityId: created.id },
          source: "location-ai.inventory.approve",
        })),
      );
    }
  }

  if (existingInventory.some((entry) => entry.product.id === productId)) {
    throw createAppError(
      "DUPLICATE_RECORD",
      `${productNameForToast} is already inventoried at this location.`,
    );
  }

  const createdInventory = await createInventoryEntry(
    db,
    {
      productId,
      locationId: input.locationId,
      amount: {
        value: Math.max(input.item.estimatedQuantity, 1),
        unit: input.item.unit,
      },
    },
    actor,
  );
  backgroundBatches.push(
    ...(await runMutationSideEffects(db, {
      action: "created",
      entity: { entityType: "inventory", entityId: createdInventory.id },
      source: "location-ai.inventory.approve",
    })),
  );

  return {
    inventoryId: createdInventory.id,
    productId,
    productName: productNameForToast,
    createdProduct,
    sideEffects: { backgroundBatches },
  };
}

/**
 * Backfill AI descriptions for all locations that have images but no description.
 * Processes in batches of 10 for throughput while limiting concurrency. Streamed:
 * `yield`s `{done,total}` after each batch (per-location writes commit
 * independently — safe to yield between them) and `return`s the summary.
 */
export async function* backfillLocationDescriptions(
  db: Database,
): AsyncGenerator<
  { done: number; total: number },
  { enqueued: number; total: number; batchId: string }
> {
  const locations = await findLocationsNeedingAiDescription(db);
  const total = locations.length;
  yield { done: 0, total };
  const dispatched = await dispatchBackgroundJobs(db, {
    kind: "location-ai.description.refresh",
    source: "backfill",
    metadata: { source: "location-ai.description.backfill", total },
    jobs: locations.map((loc) => ({
      kind: "location-ai.description.refresh" as const,
      dedupeKey: `location-ai.description.refresh:${loc.id}`,
      payload: { locationId: loc.id },
    })),
  });
  yield { done: dispatched.jobIds.length, total };
  return {
    enqueued: dispatched.jobIds.length,
    total,
    batchId: dispatched.batchId,
  };
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
  db: Database,
  ingredientName: string,
  opts: { ingredientId?: IngredientId } = {},
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

/**
 * Batch {@link suggestUsdaFood} for the enrichment workbench's "Suggest USDA for
 * selected" action. Read-only — returns one suggestion per name for the user to
 * review and commit; it never links anything. Each name is its own agent loop
 * (several USDA searches), so concurrency is bounded and the batch is capped.
 */
export async function suggestUsdaFoodBatch(
  usdaService: USDAService,
  db: Database,
  names: string[],
): Promise<UsdaFoodBatchSuggestion[]> {
  const capped = names.slice(0, 20);
  const out: UsdaFoodBatchSuggestion[] = [];
  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((name) => suggestUsdaFood(usdaService, db, name)),
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
    middleware: aiGatewayUsageMiddleware({
      db,
      feature: "ingredient-merge",
      provider: "anthropic",
      model: DEFAULT_CHAT_MODEL,
      operation: "suggestIngredientMerge",
      cacheStatus: "none",
      entity: { entityType: "ingredient", entityId: source.id },
    }),
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

// ---------------------------------------------------------------------------
// Enrichment-workbench review-queue pre-compute
//
// The review queue walks a backlog of unenriched ingredients one at a time and
// wants each row's AI proposals already on hand. This streams both proposals —
// the USDA food match and (only when asked) a merge candidate — across an
// arbitrarily long list, yielding one event per ingredient as it settles so the
// client can fill a cache ahead of the user. Read-only: it calls only the two
// read-only suggesters above and links/merges NOTHING. The user reviews and
// commits every write in the UI.
// ---------------------------------------------------------------------------

/** One ingredient's pre-computed proposals, streamed as a `BulkProgressEvent` payload. */
export interface EnrichmentProposal {
  id: IngredientId;
  usda: UsdaFoodSuggestion;
  /** Null when merge wasn't requested for this row (no trigram candidate). */
  merge: IngredientMergeSuggestion | null;
}

/**
 * Pre-compute USDA (and optional merge) proposals for a page of ingredients.
 * Runs windows of 5 concurrently — matching the per-name agent-loop concurrency
 * the batch suggesters use — and `yield`s a progress event per settled
 * ingredient so the client cache fills incrementally. A failed ingredient yields
 * a null-match proposal rather than aborting the page.
 */
export async function* precomputeEnrichmentProposals(
  usdaService: USDAService,
  db: Database,
  items: {
    id: IngredientId;
    name: string;
    wantUsda: boolean;
    wantMerge: boolean;
  }[],
): AsyncGenerator<
  BulkProgressEvent<EnrichmentProposal, { processed: number }>
> {
  const total = items.length;
  let done = 0;
  // An already-linked row needs no USDA match — skip the agent loop entirely.
  const skippedUsda: EnrichmentProposal["usda"] = {
    food: null,
    confidence: "low",
    reasoning: "",
  };
  yield { type: "progress", done, total };
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(async (item): Promise<EnrichmentProposal> => {
        const [usda, merge] = await Promise.all([
          item.wantUsda
            ? suggestUsdaFood(usdaService, db, item.name, {
                ingredientId: item.id,
              })
            : Promise.resolve(skippedUsda),
          item.wantMerge
            ? suggestIngredientMerge(db, { id: item.id, name: item.name })
            : Promise.resolve(null),
        ]);
        return { id: item.id, usda, merge };
      }),
    );
    for (let j = 0; j < settled.length; j++) {
      const res = settled[j]!;
      const item = batch[j]!;
      done++;
      const proposal: EnrichmentProposal =
        res.status === "fulfilled"
          ? res.value
          : {
              id: item.id,
              usda: {
                food: null,
                confidence: "low",
                reasoning: "Lookup failed.",
              },
              merge: null,
            };
      if (res.status === "rejected") {
        console.error(
          `[precomputeEnrichmentProposals] ${item.name} failed:`,
          res.reason,
        );
      }
      yield { type: "progress", done, total, item: proposal };
    }
  }
  yield { type: "done", result: { processed: done } };
}
