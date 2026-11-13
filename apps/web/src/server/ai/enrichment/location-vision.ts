import type {
  ApproveDetectedInventoryItemInput,
  ApproveDetectedInventoryItemOut,
  RawDetectedInventory as DetectedInventory,
  DetectedInventoryItem,
  RawDetectedItem as DetectedItem,
  LocationDescription,
} from "@cubby/schemas/ai";
/**
 * Service for AI-powered enrichment of locations and inventory.
 *
 * Handles multi-step orchestration: fetching images, calling the AI client, persisting results.
 */
import type { ActorContext } from "@cubby/schemas/context";
import {
  type LocationId,
  type ProductId,
  type ProductShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import { rawProductCategorySummary } from "@cubby/schemas/product-category-fields";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { locationDescriptionInput } from "~/server/ai/fields/analysis";
import { modelAskFor, type ModelInput } from "~/server/ai/model-asks";
import { produceModel } from "~/server/ai/model-call-context";
import { type AiCallOwner } from "~/server/ai/policy/call-owner";
import {
  buildLocationAnalysisFingerprint,
  LOCATION_DESCRIPTION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
} from "~/server/ai/policy/features";
import { readModelAnswer } from "~/server/ai/repo/model-answer";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { getDb, runBeforeCommitDatabase } from "~/server/db/helpers";
import {
  entityAttachment,
  image as imageTable,
  location as locationTable,
} from "~/server/db/schema";
import {
  getInventoryByLocationIds,
  insertInventoryEntry,
} from "~/server/domains/inventory/repo/crud";
import { readLocationAiDescription } from "~/server/domains/location/repo/ai-description";
import {
  findLocationsNeedingAiDescription,
  readLocationById,
} from "~/server/domains/location/repo/crud";
import {
  readProductById,
  quickCreateProductRecord,
} from "~/server/domains/product/repo/crud";
import { findProductByNameWithBrandClaim } from "~/server/domains/product/repo/lookup";
import { resolveProductBrandName } from "~/server/domains/vendor/repo/product-brand";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { semanticProductCandidates } from "~/server/generic/embedding/service/semantic-search.service";
import { outsideJob } from "~/server/generic/jobs/outside-job";
import type { Fenced } from "~/server/generic/jobs/types";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

const log = createLogger("ai.analysis");

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

/**
 * The images a detection reads. `imageIds` narrows to those attached images
 * (shortcodes, as `LocationOut.images[].id` returns them); an id the location
 * does not hold is ignored, so a stale id reads as "no images" rather than
 * analyzing someone else's photo.
 */
export function selectDetectionImages<T extends { id: string }>(
  images: readonly T[],
  imageIds?: readonly string[],
): T[] {
  const chosen = imageIds
    ? images.filter((image) => imageIds.includes(image.id))
    : images;
  return chosen.slice(0, MAX_ANALYSIS_IMAGES);
}

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

const detectionCategory = rawProductCategorySummary.omit({ feature: true });
type ProductCategorySummary = z.infer<typeof detectionCategory>;

interface DetectedProductMatch {
  id: ProductId;
  shortcode: ProductShortcode;
  name: string;
  brandName: string | null;
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
  /**
   * The description that stood before this run (null for the first). The run itself replaces it,
   * so a client can only show "what it was" because the server says it in the same answer.
   */
  previousDescription: string | null;
}

/** Provider work finishes before this transaction; only current inputs may publish. */
async function publishLocationAnalysis(
  fenced: Fenced,
  locationId: LocationId,
  imageCodes: readonly string[],
  currentFingerprint: (tx: Database) => Promise<string>,
  expected: string,
  write: (tx: Database) => Promise<void>,
) {
  await fenced(async (tx) => {
    await getDb(tx)
      .select({ id: locationTable.id })
      .from(locationTable)
      .where(eq(locationTable.id, locationId))
      .for("share");
    // Attachment writers lock the owner first. Image removals lock images
    // before attachments; keep that same order while publishing analysis.
    const images = await getDb(tx)
      .select({ id: imageTable.id })
      .from(imageTable)
      .where(
        and(
          inArray(imageTable.shortcode, [...imageCodes]),
          isNull(imageTable.deletedAt),
        ),
      )
      .orderBy(imageTable.id)
      .for("share");
    if (images.length)
      await getDb(tx)
        .select({ id: entityAttachment.id })
        .from(entityAttachment)
        .where(
          and(
            eq(entityAttachment.entityId, locationId),
            inArray(
              entityAttachment.imageId,
              images.map((image) => image.id),
            ),
          ),
        )
        .orderBy(entityAttachment.id)
        .for("share");
    const checkInputs = async (database: Database) => {
      if ((await currentFingerprint(database)) !== expected)
        throw new Error("Location inputs changed during analysis");
    };
    await checkInputs(tx);
    await write(tx);
    await runBeforeCommitDatabase(tx, checkInputs, "fence");
  });
}

/**
 * Analyze location photos and generate a description of contents.
 * Persists the description to the location record.
 */
export async function describeLocation(
  db: Database,
  locationId: LocationId,
  owner: AiCallOwner,
  ai: LocationVisionAiPort = productionLocationVisionAiPort,
  /** The executing Job's fence; a member request owns no Job. */
  fenced: Fenced = outsideJob(db),
): Promise<LocationDescriptionResult> {
  const location = await readLocationById(db, locationId);

  const images = (location.images ?? []).slice(0, MAX_ANALYSIS_IMAGES);
  if (images.length === 0) {
    throw new LocationHasNoImagesToAnalyzeError();
  }
  const previousDescription = await readLocationAiDescription(db, locationId);

  const inputFingerprint = buildLocationAnalysisFingerprint(
    LOCATION_DESCRIPTION_FEATURE,
    { locationName: location.name, images },
  );
  const kind = modelAskFor(LOCATION_DESCRIPTION_FEATURE);
  const input = locationDescriptionInput(location.name, images);
  const cached = await readModelAnswer(db, kind, input);
  const { withAsk, reconcileNow } = await import("~/server/kernel/api");
  const answer = await withAsk(
    db,
    {
      ...kind,
      admit:
        ai === productionLocationVisionAiPort ? kind.admit : async () => {},
      produce: () =>
        produceModel(async () => {
          const result = await ai.describeLocation(
            images.map((photo) => photo.url),
            location.name,
            {
              db,
              ...owner,
              operation: "locationDescription",
              applicationCache: false,
              entity: { entityKind: "location", entityId: locationId },
            },
          );
          return {
            output: {
              value: z.json().parse(result),
              model: LOCATION_DESCRIPTION_FEATURE.model,
            },
            model: LOCATION_DESCRIPTION_FEATURE.model,
            tier: LOCATION_DESCRIPTION_FEATURE.tier,
          };
        }),
    },
    input,
    {
      runId: owner.runId,
      scopes: [{ kind: "fields", key: `location:${locationId}` }],
    },
  );
  const result = LOCATION_DESCRIPTION_FEATURE.schema.parse(answer.value);
  await publishLocationAnalysis(
    fenced,
    locationId,
    images.map((photo) => photo.id),
    async (tx) => {
      const current = await readLocationById(tx, locationId);
      return buildLocationAnalysisFingerprint(LOCATION_DESCRIPTION_FEATURE, {
        locationName: current.name,
        images: (current.images ?? []).slice(0, MAX_ANALYSIS_IMAGES),
      });
    },
    inputFingerprint,
    async (tx) => {
      await reconcileNow(tx, [
        { kind: "fields", key: `location:${locationId}` },
      ]);
      await recordChange(tx, { kind: "projection", categories: ["location"] });
    },
  );
  return {
    ...result,
    cache: cacheMetadata(
      cached ? "hit" : "miss",
      LOCATION_DESCRIPTION_FEATURE,
      inputFingerprint,
    ),
    analyzedAt: cached?.createdAt ?? new Date(),
    previousDescription,
  };
}

async function matchDetectedItems(
  db: Database,
  locationId: LocationId,
  items: DetectedInventoryItem[],
  owner: AiCallOwner,
): Promise<{
  items: DetectedItem[];
  semanticUnavailable?: import("@cubby/schemas/ai").OptionalAiUnavailable;
}> {
  let semanticUnavailable:
    | import("@cubby/schemas/ai").OptionalAiUnavailable
    | undefined;
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
        const exactMatched = await findProductByNameWithBrandClaim(
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
                brandName: exactMatched.brandName,
                category: exactMatched.category,
              }
            : null;
        if (!matched) {
          const semantic = await semanticProductCandidates(
            db,
            productName,
            3,
            owner,
          );
          if (!Array.isArray(semantic)) semanticUnavailable ??= semantic;
          const semanticMatch = Array.isArray(semantic)
            ? semantic[0]
            : undefined;
          const semanticShortcode =
            semanticMatch?.item.entityKind === "product"
              ? parseShortcodeFor("product", semanticMatch.item.id)
              : null;
          const semanticEntityId = semanticShortcode
            ? await resolveLiveShortcode(db, semanticShortcode, "product")
            : null;
          if (
            semanticMatch &&
            semanticEntityId &&
            semanticMatch.similarity >= SEMANTIC_PRODUCT_MATCH_THRESHOLD &&
            semanticMatch.item.entityKind === "product" &&
            semanticShortcode != null &&
            !existingProductIds.has(semanticShortcode)
          ) {
            matched = {
              id: parseEntityId("product", semanticEntityId),
              shortcode: semanticShortcode,
              name: semanticMatch.item.name,
              brandName: semanticMatch.item.subtitle ?? item.manufacturer,
              category:
                detectionCategory.safeParse(semanticMatch.item.typeHint).data ??
                null,
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
                brandName: matched.brandName,
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
  return {
    items: suggestions,
    ...(semanticUnavailable ? { semanticUnavailable } : {}),
  };
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
  owner: AiCallOwner,
  imageIds?: readonly string[],
  ai: LocationVisionAiPort = productionLocationVisionAiPort,
  /** The executing Job's fence; a member request owns no Job. */
  fenced: Fenced = outsideJob(db),
): Promise<DetectedInventoryResult> {
  const location = await readLocationById(db, locationId);

  const images = selectDetectionImages(location.images ?? [], imageIds);
  if (images.length === 0) {
    throw new LocationHasNoImagesToAnalyzeError();
  }

  const inputFingerprint = buildLocationAnalysisFingerprint(
    LOCATION_INVENTORY_DETECTION_FEATURE,
    { locationName: location.name, images },
  );
  const kind = modelAskFor(LOCATION_INVENTORY_DETECTION_FEATURE);
  const input: ModelInput = {
    kind: "structured",
    model: LOCATION_INVENTORY_DETECTION_FEATURE.model,
    request: LOCATION_INVENTORY_DETECTION_FEATURE.request(
      images.map((photo) => photo.url),
      location.name,
    ),
    revision: { inputFingerprint },
  };
  const cached = await readModelAnswer(db, kind, input);
  const { withAsk } = await import("~/server/kernel/api");
  const answer = await withAsk(
    db,
    {
      ...kind,
      admit:
        ai === productionLocationVisionAiPort ? kind.admit : async () => {},
      produce: () =>
        produceModel(async () => {
          const result = await ai.detectInventoryItems(
            images.map((photo) => photo.url),
            location.name,
            {
              db,
              ...owner,
              operation: "locationInventoryDetection",
              applicationCache: false,
              entity: { entityKind: "location", entityId: locationId },
            },
          );
          return {
            output: {
              value: z.json().parse(result),
              model: LOCATION_INVENTORY_DETECTION_FEATURE.model,
            },
            model: LOCATION_INVENTORY_DETECTION_FEATURE.model,
            tier: LOCATION_INVENTORY_DETECTION_FEATURE.tier,
          };
        }),
    },
    input,
    { runId: owner.runId, record: { entity: "location", id: locationId } },
  );
  const raw = LOCATION_INVENTORY_DETECTION_FEATURE.schema.parse(answer.value);
  const cacheStatus = cached ? "hit" : "miss";
  const analyzedAt = cached?.createdAt ?? new Date();
  await publishLocationAnalysis(
    fenced,
    locationId,
    images.map((photo) => photo.id),
    async (tx) => {
      const current = await readLocationById(tx, locationId);
      return buildLocationAnalysisFingerprint(
        LOCATION_INVENTORY_DETECTION_FEATURE,
        {
          locationName: current.name,
          images: selectDetectionImages(current.images ?? [], imageIds),
        },
      );
    },
    inputFingerprint,
    async (tx) => {
      await (
        await import("~/server/ai/fields/repo/photo-evidence")
      ).appendPhotoInventoryObservation(tx, {
        locationId,
        runId: owner.runId,
        fingerprint: inputFingerprint,
        sourceSnapshot: {
          locationName: location.name,
          images: images.map((photo) => ({
            id: photo.id,
            url: photo.url,
            updatedAt: photo.updatedAt.toISOString(),
          })),
        },
        result: z.json().parse(raw),
      });
    },
  );

  const cache = detectionCacheMetadata(cacheStatus, inputFingerprint);
  log.info("analysis", {
    ...cache,
    entityKind: "location",
    entityId: locationId,
  });

  return {
    ...raw,
    ...(await matchDetectedItems(db, locationId, raw.items, owner)),
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
    const product = await readProductById(db, productId);
    productNameForToast = product.name;
  } else {
    const matched = await findProductByNameWithBrandClaim(
      db,
      productName,
      input.item.manufacturer,
    );
    if (matched) {
      productId = await resolveOrThrow(db, "product", matched.id);
      productShortcode = matched.id;
      productNameForToast = matched.name;
    } else {
      const { output: created, entityId } = await quickCreateProductRecord(
        db,
        {
          name: productName,
          brandId: await resolveProductBrandName(db, input.item.manufacturer),
        },
        actor,
      );
      productId = entityId;
      productShortcode = created.id;
      productNameForToast = created.name;
      createdProduct = true;
      await recordChange(db, { kind: "source", categories: ["product"] });
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

  const createdInventory = await insertInventoryEntry(
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
  await recordChange(db, { kind: "source", categories: ["inventory"] });

  return {
    inventoryId: createdInventory.shortcode,
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
