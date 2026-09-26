/**
 * Service for AI-powered enrichment of locations and inventory.
 *
 * Handles multi-step orchestration: fetching images, calling the AI client, persisting results.
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
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type RunId,
  type LocationId,
  type ProductId,
  type ProductShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  productCategorySummary,
  type ProductCategorySummary,
} from "@cubby/schemas/product-category-fields";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";

import { getErrorMessage } from "~/lib/error-utils";
import { recordAiUsage } from "~/server/ai-usage";
import {
  buildLocationAnalysisFingerprint,
  LOCATION_DESCRIPTION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
} from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  getCachedAiAnalysisRecord,
  upsertAiAnalysis,
} from "~/server/repo/ai-analysis";
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
import {
  resolveCreatedOrInvariant,
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { semanticProductCandidates } from "~/server/services/semantic-search.service";

const MAX_ANALYSIS_IMAGES = 5;
const DETECTED_ITEM_MATCH_BATCH_SIZE = 3;
const SEMANTIC_PRODUCT_MATCH_THRESHOLD = 0.86;
const LOCATION_NO_IMAGES_MESSAGE = "Location has no images to analyze";

export interface LocationVisionAiPort {
  describeLocation: ReturnType<typeof getAiClient>["describeLocation"];
  detectInventoryItems: ReturnType<typeof getAiClient>["detectInventoryItems"];
}

const productionLocationVisionAiPort: LocationVisionAiPort = {
  describeLocation: (...args) => getAiClient().describeLocation(...args),
  detectInventoryItems: (...args) =>
    getAiClient().detectInventoryItems(...args),
};

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
  id: ProductId;
  shortcode: ProductShortcode;
  name: string;
  manufacturer: string;
  category: ProductCategorySummary | null;
}

// Router inputs use a public location shortcode. This service receives the
// resolved UUID because its repository writes and AI records remain internal.
type ApproveDetectedInventoryItemRequest = Omit<
  ApproveDetectedInventoryItemInput,
  "locationId"
> & {
  locationId: LocationId;
};

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
    runId: RunId;
  },
): Promise<void> {
  await recordAiUsage(db, {
    feature: input.feature.feature,
    provider: providerFor(input.feature.model),
    model: input.feature.model,
    operation: input.operation,
    runId: input.runId,
    inputTokens: null,
    outputTokens: null,
    durationMs: input.durationMs,
    cacheStatus: input.cacheStatus,
    entity: { entityType: "location", entityId: input.locationId },
  });
}

/**
 * The description plus where it came from. The provenance travels with the
 * answer because the UI labels it: which model read the shelf, when it read
 * it, and whether this call re-read it or replayed a stored analysis. A cache
 * hit can be months old, so `analyzedAt` is the stored row's timestamp rather
 * than the time of this request.
 */
export interface LocationDescriptionResult extends LocationDescription {
  cache: ReturnType<typeof cacheMetadata>;
  analyzedAt: Date;
}

/**
 * Analyze location photos and generate a description of contents.
 * Persists the description to the location record.
 */
export async function describeLocation(
  db: Database,
  locationId: LocationId,
  runId: RunId,
  ai: LocationVisionAiPort = productionLocationVisionAiPort,
): Promise<LocationDescriptionResult> {
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
  const cached = await getCachedAiAnalysisRecord(db, analysisKey);
  if (cached) {
    const hitMetadata = cacheMetadata(
      "hit",
      LOCATION_DESCRIPTION_FEATURE,
      inputFingerprint,
    );
    console.info("ai.analysis", {
      ...hitMetadata,
      entityType: "location",
      entityId: locationId,
    });
    if (location.aiDescription !== cached.result.description) {
      await updateLocationAiDescription(
        db,
        locationId,
        cached.result.description,
      );
      await runMutationSideEffects(db, {
        action: "updated",
        entity: { entity: "location", id: locationId },
        source: "location-ai.description",
      });
    }
    await recordLocationAiUsage(db, {
      feature: LOCATION_DESCRIPTION_FEATURE,
      operation: "locationDescription",
      cacheStatus: "hit",
      durationMs: 0,
      locationId,
      runId,
    });
    return {
      ...cached.result,
      cache: hitMetadata,
      analyzedAt: cached.analyzedAt,
    };
  }

  const result = await ai.describeLocation(
    images.map((img) => img.url),
    location.name,
    {
      db,
      runId,
      operation: "locationDescription",
      cacheStatus: "miss",
      entity: { entityType: "location", entityId: locationId },
    },
  );
  await upsertAiAnalysis(db, analysisKey, result);
  const missMetadata = cacheMetadata(
    "miss",
    LOCATION_DESCRIPTION_FEATURE,
    inputFingerprint,
  );
  console.info("ai.analysis", {
    ...missMetadata,
    entityType: "location",
    entityId: locationId,
  });

  await updateLocationAiDescription(db, locationId, result.description);
  await runMutationSideEffects(db, {
    action: "updated",
    entity: { entity: "location", id: locationId },
    source: "location-ai.description",
  });

  return { ...result, cache: missMetadata, analyzedAt: new Date() };
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

  const unmatchedItems = items.flatMap((item) => {
    const productName = itemProductName(item);
    if (
      existingNames.has(normalizedProductName(productName)) ||
      existingInventoryNames.some((existingName) =>
        isDetectedItemCoveredByInventoryName(productName, existingName),
      )
    ) {
      return [];
    }
    return [{ item, productName }];
  });

  const suggestions: DetectedItem[] = [];
  // Product matching makes database and semantic-search calls. Preserve source
  // ordering while issuing a small, bounded window instead of serial N+1 work.
  for (
    let index = 0;
    index < unmatchedItems.length;
    index += DETECTED_ITEM_MATCH_BATCH_SIZE
  ) {
    const batch = unmatchedItems.slice(
      index,
      index + DETECTED_ITEM_MATCH_BATCH_SIZE,
    );
    const matchedItems = await Promise.all(
      batch.map(async ({ item, productName }): Promise<DetectedItem | null> => {
        const exactMatched = await findProductByNameFuzzyManufacturer(
          db,
          productName,
          item.manufacturer,
        );
        const exactMatchedId = exactMatched
          ? await resolveLiveShortcode(db, exactMatched.id, "product")
          : null;
        let matched: DetectedProductMatch | null =
          exactMatched && exactMatchedId
            ? {
                id: parseEntityId("product", exactMatchedId),
                shortcode: exactMatched.id,
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
          const semanticShortcode =
            semanticMatch?.item.entityType === "product"
              ? parseShortcodeFor("product", semanticMatch.item.id)
              : null;
          const semanticEntityId = semanticShortcode
            ? await resolveLiveShortcode(db, semanticShortcode, "product")
            : null;
          if (
            semanticMatch &&
            semanticEntityId &&
            semanticMatch.similarity >= SEMANTIC_PRODUCT_MATCH_THRESHOLD &&
            semanticMatch.item.entityType === "product" &&
            semanticShortcode != null &&
            !existingProductIds.has(semanticShortcode)
          ) {
            matched = {
              id: parseEntityId("product", semanticEntityId),
              shortcode: semanticShortcode,
              name: semanticMatch.item.name,
              manufacturer: semanticMatch.item.subtitle ?? item.manufacturer,
              category:
                productCategorySummary.safeParse(semanticMatch.item.typeHint)
                  .data ?? null,
            };
          }
        }
        if (matched && existingProductIds.has(matched.shortcode)) return null;

        return {
          ...item,
          name: productName,
          matchedProduct: matched
            ? {
                id: matched.shortcode,
                name: matched.name,
                manufacturer: matched.manufacturer,
                category: matched.category,
              }
            : null,
        };
      }),
    );
    suggestions.push(
      ...matchedItems.filter((item): item is DetectedItem => item !== null),
    );
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
    const parsedError = error instanceof Error ? error : null;
    console.warn("ai.inventory.semantic-product-match.failed", {
      query,
      errorName: parsedError?.name ?? "UnparsedError",
      message: getErrorMessage(error),
    });
    return [];
  }
}

/**
 * The detection plus when the shelf was actually read — see
 * {@link LocationDescriptionResult}. `cache` already named the model and the
 * hit/miss; the timestamp is what makes a hit readable as "read in March"
 * rather than "read now".
 */
export interface DetectedInventoryResult extends DetectedInventory {
  analyzedAt: Date;
}

/**
 * Detect inventory items from location photos.
 * Returns detected items for user review — does not persist anything.
 */
export async function detectInventoryItems(
  db: Database,
  locationId: LocationId,
  runId: RunId,
  ai: LocationVisionAiPort = productionLocationVisionAiPort,
): Promise<DetectedInventoryResult> {
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
  const cached = await getCachedAiAnalysisRecord(db, analysisKey);
  const cacheStatus = cached ? "hit" : "miss";
  let raw: DetectedInventoryAiResult;
  let analyzedAt = new Date();

  if (cached) {
    raw = cached.result;
    analyzedAt = cached.analyzedAt;
    await recordLocationAiUsage(db, {
      feature: LOCATION_INVENTORY_DETECTION_FEATURE,
      operation: "locationInventoryDetection",
      cacheStatus: "hit",
      durationMs: 0,
      locationId,
      runId,
    });
  } else {
    raw = await ai.detectInventoryItems(
      images.map((img) => img.url),
      location.name,
      {
        db,
        runId,
        operation: "locationInventoryDetection",
        cacheStatus: "miss",
        entity: { entityType: "location", entityId: locationId },
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
    analyzedAt,
  };
}

export async function approveDetectedInventoryItem(
  db: Database,
  input: ApproveDetectedInventoryItemRequest,
  actor: ActorContext,
): Promise<ApproveDetectedInventoryItemOut> {
  const productName = itemProductName(input.item);
  const existingInventory = await getInventoryByLocationIds(db, [
    input.locationId,
  ]);

  let productId: ProductId | null = input.productId
    ? await resolveOrThrow(db, "product", input.productId)
    : null;
  let productShortcode = input.productId ?? null;
  let productNameForToast = productName;
  let createdProduct = false;

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
      productId = await resolveOrThrow(db, "product", matched.id);
      productShortcode = matched.id;
      productNameForToast = matched.name;
    } else {
      const created = await quickCreateProduct(
        db,
        {
          name: productName,
          manufacturer: input.item.manufacturer,
        },
        actor,
      );
      productId = await resolveCreatedOrInvariant(db, "product", created.id);
      productShortcode = created.id;
      productNameForToast = created.name;
      createdProduct = true;
      await runMutationSideEffects(db, {
        action: "created",
        entity: { entity: "product", id: productId },
        source: "location-ai.inventory.approve",
      });
    }
  }

  if (
    existingInventory.some((entry) => entry.product.id === productShortcode)
  ) {
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
  const inventoryEntityId = await resolveCreatedOrInvariant(
    db,
    "inventory",
    createdInventory.id,
  );
  await runMutationSideEffects(db, {
    action: "created",
    entity: { entity: "inventory", id: inventoryEntityId },
    source: "location-ai.inventory.approve",
  });

  return {
    inventoryId: createdInventory.id,
    productId: productShortcode!,
    productName: productNameForToast,
    createdProduct,
    sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
  };
}

/** Select the locations the description backfill will publish, as one
 * snapshot so progress and the published set agree. */
export const selectLocationDescriptionBackfill = async (
  db: Database,
): Promise<LocationId[]> => {
  const locations = await findLocationsNeedingAiDescription(db);
  return locations.map((location) => location.id);
};

/** Publish one description-refresh task per selected location. */
export const enqueueLocationDescriptionBackfill = async (
  db: Database,
  locationIds: readonly LocationId[],
): Promise<{ enqueued: number; total: number }> => {
  const requestedAt = new Date().toISOString();
  const receipt = await publishBackgroundTasks(
    db,
    locationIds.map((locationId) => ({
      kind: "location-ai.description.refresh" as const,
      requestedAt,
      locationId,
    })),
    { source: "location-ai.description.backfill" },
  );
  return { enqueued: receipt.count, total: locationIds.length };
};
