/**
 * Service for AI-powered enrichment of locations and inventory.
 *
 * Handles multi-step orchestration: fetching images, calling Anthropic, persisting results.
 */

import type {
  ApproveDetectedInventoryItemInput,
  ApproveDetectedInventoryItemOut,
  DetectedInventory,
  DetectedInventoryAiResult,
  DetectedInventoryItem,
  DetectedItem,
  LocationDescription,
} from "@cubby/schemas/ai";
import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import { type LocationId, unsafeProductId } from "@cubby/schemas/identifiers";
import { type ProductCategory, productCategory } from "@cubby/schemas/product";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import { getErrorMessage } from "~/lib/error-utils";
import {
  buildLocationAnalysisFingerprint,
  LOCATION_DESCRIPTION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
} from "~/server/ai/features";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  getCachedAiAnalysis,
  upsertAiAnalysis,
} from "~/server/repo/ai-analysis";
import { recordAiUsage } from "~/server/repo/ai-usage";
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
