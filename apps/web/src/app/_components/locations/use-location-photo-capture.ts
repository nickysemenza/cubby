/**
 * Capture a location photo straight from the camera, with no entity form in the
 * way. The one place the upload→attach→cover sequence lives: the photo pass, the
 * scanned-bin landing, and the recount session's capture pane all call this.
 *
 * Three steps, and the ordering of the last two is load-bearing:
 *
 * 1. `image.uploadImage` mints a PENDING row and a presigned R2 PUT.
 * 2. The PUT puts bytes at that key. A row left PENDING with no incoming edge is
 *    culled (row *and* object) after ~24h, so step 3 is not optional.
 * 3. `location.update({ pendingImageIds })` inserts the join row and flips the
 *    row to UPLOADED — `associatePendingImages` does both — which is also what
 *    trips `locationImagesChanged` and re-enqueues the location's AI description
 *    and inventory refresh. Never call `ai.describeLocation` alongside this;
 *    that bills a second vision pass for the same photo.
 *
 * `markUploaded` is deliberately absent: `associatePendingImages`' status UPDATE
 * is unconditional, so finalizing separately would only open a window where an
 * UPLOADED-but-unreferenced row is eligible for the 1h unreferenced sweep.
 *
 * ## Why the cover reorder is a second round trip
 *
 * `updateLocation` applies `imageOrder` *before* it associates pending images,
 * so an id with no join row yet cannot be ordered — `applyImageOrder`'s UPDATE
 * matches nothing. A retake therefore sends a second, order-only update once the
 * row exists.
 *
 * Swapping those two server statements would make one call enough, and is the
 * wrong trade. `imageOrder` is contractually a list of *existing* ids (it says
 * so in `locationUpdateData`, which MCP advertises to agents), and every caller
 * honors that: `useImageState` only ever reorders images the entity already had.
 * Under a swapped order those callers would renumber their existing images to
 * `0..n-1` *after* the new image took `max(sortOrder) + 1` — which on a location
 * whose join rows all sit at the legacy `0` default is `1`, silently pushing
 * most of the existing images behind the newcomer. Product, recipe, and purchase
 * run the byte-identical sequence, so the fix would also fork four code paths
 * that today read once.
 *
 * The round trip is cheap where it lands: only a retake pays it. A location with
 * no photos yet — the whole backlog case — is a single call. And it does not
 * re-enqueue the AI work, because `locationImagesChanged` is computed from
 * `pendingImageIds`/`removeImageIds` and deliberately excludes `imageOrder`.
 */

import type {
  ImageShortcode,
  LocationShortcode,
} from "@cubby/schemas/identifiers";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@cubby/schemas/image";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidateTags,
} from "~/lib/background-batch-polling";
import { imageUpload } from "~/lib/image.functions";

export function useLocationPhotoCapture() {
  const queryClient = useQueryClient();
  const uploadImage = useMutation(imageUpload.uploadImage.mutationOptions());
  const updateLocation = useMutation(
    entityMutationOptionsFactory("location", "update")(),
  );

  const invalidate = useCallback(
    (result?: unknown) => {
      void invalidateOperationTags(queryClient, ripple.location);
      // The AI description lands later, off the background queue — re-invalidate
      // when it drains so the description fills in without a reload.
      void watchBatchesAndInvalidateTags({
        queryClient,
        result,
        invalidateTags: ripple.location,
        fetchBatchStatus: makeBatchStatusFetcher(queryClient),
      });
    },
    [queryClient],
  );

  /**
   * Attach `file` to `locationId` as its new cover, keeping whatever was there.
   * Throws on failure — callers own the toast (a multi-step file flow toasting
   * from `mutateAsync` in try/catch is the documented carve-out from
   * `useActionMutation`).
   */
  const capture = useCallback(
    async (
      locationId: LocationShortcode,
      file: File,
    ): Promise<ImageShortcode> => {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageType)) {
        // iOS hands over an empty or exotic MIME type often enough that this
        // needs to fail as a readable message, not an opaque server zod reject
        // three steps into a walk.
        throw new Error(
          `Unsupported image type: ${file.type || "unknown"}. Allowed: JPEG, PNG, GIF, WebP, HEIC.`,
        );
      }
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
        throw new Error(`${file.name} exceeds the upload size limit.`);
      }

      const init = await uploadImage.mutateAsync({
        filename: file.name,
        contentType: file.type as AllowedImageType,
        size: file.size,
        entityType: "LOCATION",
      });

      const put = await fetch(init.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Image upload failed (${put.status})`);

      const attached = await updateLocation.mutateAsync({
        id: locationId,
        data: { pendingImageIds: [init.imageId] },
      });

      // `init.imageId` is the raw upload uuid — `imageOrder`/`removeImageIds`
      // take the public `IMG-` shortcode instead, which only exists once the
      // server hands it back in `attached.images`. Recovered here rather than
      // resolved separately: `associatePendingImages` appends via
      // `nextImageSortOrder` (max + 1), so the image just attached always has
      // the highest sortOrder, and the response orders images by sortOrder —
      // making it reliably the LAST entry.
      const newCode = attached.images.at(-1)!.id;

      // Order off the server's own post-attach list rather than a caller-held
      // snapshot. A stale or filtered list would omit ids, and an omitted id
      // keeps its old sortOrder — on legacy rows that all sit at `0` it would
      // then TIE the new cover at 0, and the relation's `createdAt` tiebreak
      // hands the cover back to the older photo.
      const otherIds = attached.images
        .map((img) => img.id)
        .filter((id) => id !== newCode);
      if (otherIds.length > 0) {
        await updateLocation.mutateAsync({
          id: locationId,
          data: { imageOrder: [newCode, ...otherIds] },
        });
      }

      invalidate(attached);
      return newCode;
    },
    [uploadImage, updateLocation, invalidate],
  );

  /**
   * Throw away the frame just taken and hand the stop back for another go.
   *
   * Scoped to the immediately-preceding capture, never a history: this detaches
   * one specific new image (deleting its R2 object, since nothing else
   * references it) and leaves every prior photo untouched. That is a discard of
   * something not yet meaningfully saved, not the entity-level restore/undo the
   * project deliberately doesn't implement.
   *
   * Idempotent — the detach deletes by `imageId IN (...)`, so a double tap is a
   * no-op.
   */
  const discardCapture = useCallback(
    async (
      locationId: LocationShortcode,
      imageId: ImageShortcode,
    ): Promise<void> => {
      const result = await updateLocation.mutateAsync({
        id: locationId,
        data: { removeImageIds: [imageId] },
      });
      invalidate(result);
    },
    [updateLocation, invalidate],
  );

  return {
    capture,
    discardCapture,
    isCapturing: uploadImage.isPending || updateLocation.isPending,
  };
}
