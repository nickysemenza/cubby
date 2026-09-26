import { z } from "zod";
import { searchableEntities } from "./entity-manifest";
import { imageId, locationId, parseEntityRef, recipeId } from "./identifiers";
import { imageProcessingResult } from "./image-processing";

/**
 * Background tasks are self-contained queue payloads: the message carries
 * everything the handler needs, and no execution row exists behind it.
 *
 * Every kind here is idempotent by construction — the handler re-checks the
 * derived state's own freshness marker (a stale flag, a hash, a fingerprint
 * cache) before doing work, so duplicate or out-of-order delivery is a no-op.
 * The stale marker on the source row, not the message, is the durable record
 * of pending work; a lost message is repaired on read or by "Settle now".
 */
export const backgroundTaskKinds = [
  "recipe-totals.recompute",
  "entity-embedding.refresh",
  "location-ai.description.refresh",
  "location-ai.inventory.refresh",
  "image-processing.wakeup",
  "image-processing.result",
  "image-metadata.extract",
  "maintenance.recover",
  "maintenance.purchase-discovery",
] as const;

export const backgroundTaskKindSchema = z.enum(backgroundTaskKinds);
export type BackgroundTaskKind = z.infer<typeof backgroundTaskKindSchema>;

/**
 * One recompute message covers at most this many recipes so a single queue
 * invocation stays inside its CPU budget even when every recipe in the chunk
 * has a large ingredient closure. Publishers split larger sets.
 */
export const RECIPE_RECOMPUTE_CHUNK_SIZE = 25;

const taskEnvelopeFields = {
  /** When the publisher observed the change; handlers use it for freshness gates. */
  requestedAt: z.iso.datetime(),
  /**
   * The Run whose actor issued the mutation that queued this task, when one
   * exists. Optional so a message already in flight from the preceding
   * deployment (with no `runId` key at all) still parses; the handler falls
   * back to `systemActor()` when it is absent.
   */
  runId: z.uuid().optional(),
};

export const recipeTotalsRecomputeTaskSchema = z.object({
  kind: z.literal("recipe-totals.recompute"),
  ...taskEnvelopeFields,
  recipeIds: z.array(recipeId).min(1).max(RECIPE_RECOMPUTE_CHUNK_SIZE),
});

const searchableEntitySchema = z.enum(searchableEntities);

/**
 * Brand the ref once at the queue ingress seam so handlers receive typed ids
 * and the `ref` needed by the search-document repositories.
 */
export const entityEmbeddingRefreshTaskSchema = z
  .object({
    kind: z.literal("entity-embedding.refresh"),
    ...taskEnvelopeFields,
    entityType: searchableEntitySchema,
    entityId: z.uuid(),
  })
  .transform((task) => {
    const ref = parseEntityRef(task.entityType, task.entityId);
    return { ...task, entityType: ref.entity, entityId: ref.id, ref };
  });

export const locationAiDescriptionRefreshTaskSchema = z.object({
  kind: z.literal("location-ai.description.refresh"),
  ...taskEnvelopeFields,
  locationId,
});

export const locationAiInventoryRefreshTaskSchema = z.object({
  kind: z.literal("location-ai.inventory.refresh"),
  ...taskEnvelopeFields,
  locationId,
});

/** A job id is only a wakeup; Postgres remains the authoritative queue. */
export const imageProcessingWakeupTaskSchema = z.object({
  kind: z.literal("image-processing.wakeup"),
  ...taskEnvelopeFields,
  jobId: z.uuid(),
});

/** A companion result is replay-safe because the lease attempt gates adoption. */
export const imageProcessingResultTaskSchema = z.object({
  kind: z.literal("image-processing.result"),
  ...taskEnvelopeFields,
  result: imageProcessingResult,
});

/**
 * A wakeup to (re-)extract an uploaded image's embedded EXIF/GPS metadata.
 * The handler re-reads `Image.metadataRevision` against
 * `IMAGE_METADATA_REVISION` before doing any work, so a duplicate or
 * out-of-order delivery after the image already advanced is a no-op.
 */
export const imageMetadataExtractTaskSchema = z.object({
  kind: z.literal("image-metadata.extract"),
  ...taskEnvelopeFields,
  imageId,
});

/** Catch-up scans read the durable source rows/cursors and tolerate replay. */
export const maintenanceRecoverTaskSchema = z.object({
  kind: z.literal("maintenance.recover"),
  ...taskEnvelopeFields,
});

export const maintenancePurchaseDiscoveryTaskSchema = z.object({
  kind: z.literal("maintenance.purchase-discovery"),
  ...taskEnvelopeFields,
});

export const backgroundTaskSchema = z.discriminatedUnion("kind", [
  recipeTotalsRecomputeTaskSchema,
  entityEmbeddingRefreshTaskSchema,
  locationAiDescriptionRefreshTaskSchema,
  locationAiInventoryRefreshTaskSchema,
  imageProcessingWakeupTaskSchema,
  imageProcessingResultTaskSchema,
  imageMetadataExtractTaskSchema,
  maintenanceRecoverTaskSchema,
  maintenancePurchaseDiscoveryTaskSchema,
]);

/** The parsed (branded) task a handler receives. */
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;
/** The task a publisher constructs, before ingress parsing. */
export type BackgroundTaskInput = z.input<typeof backgroundTaskSchema>;

/**
 * What an explicit enqueue action reports back: how the work was accepted and
 * how many tasks it produced. No batch or job identity exists to return.
 */
export const backgroundTaskReceiptSchema = z.object({
  transport: z.enum(["queue", "inline"]),
  count: z.number().int().nonnegative(),
});
export type BackgroundTaskReceipt = z.infer<typeof backgroundTaskReceiptSchema>;
