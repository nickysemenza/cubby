import { z } from "zod";

// A leaf module: `run-fields` types `Run.input` with these, and
// `photo-import-run` imports `run-fields`, so they import only zod.

/**
 * Who groups a photo Run's photos, chosen per Run when it is created:
 * `cubby` = Cubby's Pi coordinator groups automatically once uploads and
 * descriptions settle; `external` = a Claude/Codex session groups it over MCP
 * from the copyable handoff prompt, and the server never dispatches Pi.
 */
export const photoRunProcessor = z.enum(["cubby", "external"]);
export type PhotoRunProcessor = z.infer<typeof photoRunProcessor>;

/**
 * One upload batch the native uploader admitted, keyed by its durable
 * client UUID so a retried admission (process death before the journal
 * acknowledged it) is a no-op. `open` until the uploader seals it after its
 * last finalize chunk, or gives up on the rest; automatic grouping never
 * starts while any batch is open, so a batch finalized in several 100-photo
 * chunks is grouped once, whole. `imageCount` is the photos it planned, for
 * progress only.
 */
export const photoRunUploadBatch = z.strictObject({
  clientBatchId: z.uuid(),
  imageCount: z.int().positive(),
  /**
   * First `finalize.position` of this batch: the planned counts of every
   * earlier batch, fixed at admission so a resumed batch keeps it. The first
   * batch starts at 0.
   */
  positionOffset: z.int().nonnegative(),
  state: z.enum(["open", "sealed"]),
});
export type PhotoRunUploadBatch = z.infer<typeof photoRunUploadBatch>;

/**
 * `Run.input` of a photo-inventory Run. A legacy Run with a null input keeps
 * manual Start grouping semantics.
 */
export const photoInventoryRunInput = z.strictObject({
  kind: z.literal("photo_inventory"),
  processor: photoRunProcessor,
  batches: z.array(photoRunUploadBatch).max(500),
});
export type PhotoInventoryRunInput = z.infer<typeof photoInventoryRunInput>;

/** `Run.input` as stored: a legacy Run's null keeps manual grouping. */
export const storedPhotoRunInput = photoInventoryRunInput.nullable();
