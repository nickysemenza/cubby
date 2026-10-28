import { z } from "zod";
import { searchableEntities } from "./generated/entity-roster.gen";
import { imageId, locationId, parseEntityRef } from "./identifiers";

/** Domain admission inputs. Publishers persist Job intent; transport carries only a wake. */
export const backgroundTaskKinds = [
  "entity-embedding.refresh",
  "location-ai.description.refresh",
  "location-ai.inventory.refresh",
  "image-processing.wakeup",
  "image-metadata.extract",
  "maintenance.purchase-discovery",
  "calendar-feed.mark-dirty",
] as const;

export const backgroundTaskKindSchema = z.enum(backgroundTaskKinds);
export type BackgroundTaskKind = z.infer<typeof backgroundTaskKindSchema>;

const taskEnvelopeFields = {
  /** Timestamp retained with the durable admission input. */
  requestedAt: z.iso.datetime(),
  /** Run provenance for mutations that have an owning Run. */
  runId: z.uuid().optional(),
};

const searchableEntitySchema = z.enum(searchableEntities);

/**
 * Brand the ref once at the queue ingress seam so handlers receive typed ids
 * and the `ref` needed by the search-document repositories.
 */
export const entityEmbeddingRefreshTaskSchema = z
  .object({
    kind: z.literal("entity-embedding.refresh"),
    ...taskEnvelopeFields,
    entityKind: searchableEntitySchema,
    entityId: z.uuid(),
  })
  .transform((task) => {
    const ref = parseEntityRef(task.entityKind, task.entityId);
    return { ...task, entityKind: ref.entity, entityId: ref.id, ref };
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

export const maintenancePurchaseDiscoveryTaskSchema = z.object({
  kind: z.literal("maintenance.purchase-discovery"),
  ...taskEnvelopeFields,
});

/**
 * Fallback for a dirty-mark RPC that failed every in-request retry. `markDirty`
 * only sets a flag on the origin's calendar Durable Object, so replay is
 * harmless; the handler throws on failure so the queue keeps retrying.
 */
export const calendarFeedMarkDirtyTaskSchema = z.object({
  kind: z.literal("calendar-feed.mark-dirty"),
  ...taskEnvelopeFields,
  origin: z.url(),
  reason: z.string().min(1),
});

export const backgroundTaskSchema = z.discriminatedUnion("kind", [
  entityEmbeddingRefreshTaskSchema,
  locationAiDescriptionRefreshTaskSchema,
  locationAiInventoryRefreshTaskSchema,
  imageProcessingWakeupTaskSchema,
  imageMetadataExtractTaskSchema,
  maintenancePurchaseDiscoveryTaskSchema,
  calendarFeedMarkDirtyTaskSchema,
]);

/** The parsed (branded) task a handler receives. */
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;
/** The task a publisher constructs, before ingress parsing. */
export type BackgroundTaskInput = z.input<typeof backgroundTaskSchema>;

/**
 * What an explicit enqueue action reports back: how many tasks durable admission
 * accepted. A queue wake is optional and does not own execution.
 */
export const backgroundTaskReceiptSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type BackgroundTaskReceipt = z.infer<typeof backgroundTaskReceiptSchema>;
