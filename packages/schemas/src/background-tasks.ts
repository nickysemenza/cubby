import { z } from "zod";
import { searchableEntities } from "./generated/entity-roster.gen";
import { locationId, parseEntityRef } from "./identifiers";

export const locationAiJobKey = (
  kind: "location-ai.inventory.refresh",
  locationId: string,
) => `${kind}:${locationId}`;

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
const entityEmbeddingRefreshTaskSchema = z
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

export const locationAiInventoryRefreshTaskSchema = z.object({
  kind: z.literal("location-ai.inventory.refresh"),
  ...taskEnvelopeFields,
  locationId,
});

const maintenancePurchaseDiscoveryTaskSchema = z.object({
  kind: z.literal("maintenance.purchase-discovery"),
  ...taskEnvelopeFields,
  /**
   * Keyset cursor for the sender scan. A full page republishes the same Job
   * with the last admitted Email id so the next pass does not reread it.
   */
  senderAfter: z
    .object({
      mailboxId: z.string().min(1),
      afterId: z.uuid(),
    })
    .optional(),
});

/**
 * Fallback for a dirty-mark RPC that failed every in-request retry. `markDirty`
 * only sets a flag on the origin's calendar Durable Object, so replay is
 * harmless; the handler throws on failure so the queue keeps retrying.
 */
const calendarFeedMarkDirtyTaskSchema = z.object({
  kind: z.literal("calendar-feed.mark-dirty"),
  ...taskEnvelopeFields,
  origin: z.url(),
  reason: z.string().min(1),
});

/** Domain admission inputs. Publishers persist Job intent; transport carries only a wake. */
export const backgroundTaskSchema = z.discriminatedUnion("kind", [
  entityEmbeddingRefreshTaskSchema,
  locationAiInventoryRefreshTaskSchema,
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
const backgroundTaskReceiptSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type BackgroundTaskReceipt = z.infer<typeof backgroundTaskReceiptSchema>;
