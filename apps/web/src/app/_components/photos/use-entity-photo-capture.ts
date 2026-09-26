/**
 * Capture a gallery entity's photo straight from the camera, with no entity
 * form in the way. The one place the upload→attach→cover sequence lives: the
 * location photo pass, the scanned-bin landing, the recount session's capture
 * pane, and any `EntityPhotosSection` add-photo affordance all call this
 * (directly, or through `useLocationPhotoCapture`'s thin wrapper).
 *
 * Three steps, and the ordering of the last two is load-bearing:
 *
 * 1. `image.uploadImage` mints a PENDING row and a presigned R2 PUT.
 * 2. The PUT puts bytes at that key. A row left PENDING with no incoming edge is
 *    culled (row *and* object) after ~24h, so step 3 is not optional.
 * 3. `<entity>.update({ pendingImageIds })` inserts the join row and flips the
 *    row to UPLOADED — `associatePendingImages` does both. For location this is
 *    also what trips `locationImagesChanged` and re-enqueues its AI description
 *    and inventory refresh; never call `ai.describeLocation` alongside this,
 *    that bills a second vision pass for the same photo.
 *
 * `markUploaded` is deliberately absent: `associatePendingImages`' status UPDATE
 * is unconditional, so finalizing separately would only open a window where an
 * UPLOADED-but-unreferenced row is eligible for the 1h unreferenced sweep.
 *
 * ## Why the cover reorder is a second round trip
 *
 * `update<Entity>` applies `imageOrder` *before* it associates pending images,
 * so an id with no join row yet cannot be ordered — `applyImageOrder`'s UPDATE
 * matches nothing. A retake therefore sends a second, order-only update once the
 * row exists.
 *
 * Swapping those two server statements would make one call enough, and is the
 * wrong trade. `imageOrder` is contractually a list of *existing* ids (it says
 * so in every gallery entity's update data, which MCP advertises to agents),
 * and every caller honors that: `useImageState` only ever reorders images the
 * entity already had. Under a swapped order those callers would renumber their
 * existing images to `0..n-1` *after* the new image took `max(sortOrder) + 1` —
 * which on an entity whose join rows all sit at the legacy `0` default is `1`,
 * silently pushing most of the existing images behind the newcomer. Every
 * gallery entity runs the byte-identical sequence (`syncEntityImages`), so the
 * fix would also fork every one of those code paths that today read once.
 *
 * The round trip is cheap where it lands: only a retake pays it. An entity with
 * no photos yet — the whole backlog case — is a single call. And it does not
 * re-enqueue location's AI work, because `locationImagesChanged` is computed
 * from `pendingImageIds`/`removeImageIds` and deliberately excludes
 * `imageOrder`.
 *
 * `capture`'s `asCover` (default `true`) opts out of this second round trip:
 * a multi-file batch (`EntityPhotosSection`'s "Add photos") passes `false` so
 * files keep their pick order instead of each one briefly becoming the cover
 * in turn.
 */

import { entityImageOf } from "@cubby/schemas/entity";
import type { GalleryEntity } from "@cubby/schemas/entity-manifest";
import type { ImageShortcode } from "@cubby/schemas/identifiers";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
  type ImageOut,
} from "@cubby/schemas/image";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  entityMutationOptionsFactory,
  type EntityMutationData,
  type EntityMutationTransport,
  type EntityMutationVariables,
} from "~/entities/entity-contracts";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { imageUpload } from "~/lib/image.functions";
import {
  PresignedUploadError,
  putPresignedObject,
} from "~/lib/presigned-upload";

type GalleryEntityId<E extends GalleryEntity> = EntityMutationVariables<
  E,
  "update"
>["id"];
type GalleryUpdateVariables<E extends GalleryEntity> = EntityMutationVariables<
  E,
  "update"
>;
/**
 * Not every `GalleryEntity` update result carries `images` on its output type
 * (project attaches through a different path today), so the response is
 * asserted here for the entities this hook actually serves — location and the
 * generic-editor gallery entities (meal, task, planting) all return their full
 * `images` list from `update`.
 */
type GalleryUpdateResult<E extends GalleryEntity> = EntityMutationData<
  E,
  "update"
> & { images: ImageOut[] };

export interface UseEntityPhotoCaptureOptions {
  /** Run after the standard cache invalidation, for a caller with extra ripple. */
  onInvalidated?: () => void;
  /** Injectable transport seams for tests; production keeps the real ones. */
  transport?: EntityMutationTransport;
  uploadImageOperation?: typeof imageUpload.uploadImage;
}

/** Generic entity-photo capture: `EntityMutationVariables<E, "update">` isn't
 * narrowable over a generic `E` without a hand-written union of every gallery
 * entity's own update shape, so the payload is asserted below instead — every
 * gallery entity's generated update schema accepts the same
 * `pendingImageIds`/`imageOrder`/`removeImageIds` write fields, applied by one
 * shared `syncEntityImages` server-side helper. */
export function useEntityPhotoCapture<E extends GalleryEntity>(
  entity: E,
  {
    onInvalidated,
    transport,
    uploadImageOperation = imageUpload.uploadImage,
  }: UseEntityPhotoCaptureOptions = {},
) {
  const queryClient = useQueryClient();
  const uploadImage = useMutation(uploadImageOperation.mutationOptions());
  const updateEntity = useMutation(
    entityMutationOptionsFactory(entity, "update", transport)(),
  );
  const entityType = entityImageOf(entity);

  const invalidate = useCallback(() => {
    void invalidateOperationTags(queryClient, ripple[entity]);
    onInvalidated?.();
  }, [queryClient, entity, onInvalidated]);

  /**
   * Attach `file` to `id`. Throws on failure — callers own the toast (a
   * multi-step file flow toasting from `mutateAsync` in try/catch is the
   * documented carve-out from `useActionMutation`).
   *
   * `asCover` (default `true`) makes the new photo the entity's cover via the
   * second round-trip documented above. Pass `false` for a multi-file batch
   * (`EntityPhotosSection`'s "Add photos"): keeping pick order instead of
   * every file in turn briefly becoming the cover, and skipping the reorder
   * round trip entirely.
   */
  const capture = useCallback(
    async (
      id: GalleryEntityId<E>,
      file: File,
      { asCover = true }: { asCover?: boolean } = {},
    ): Promise<ImageShortcode> => {
      const contentType = ALLOWED_IMAGE_TYPES.find(
        (type) => type === file.type,
      );
      if (!contentType) {
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
        contentType,
        size: file.size,
        entityType,
      });

      try {
        await putPresignedObject(init.uploadUrl, file, contentType);
      } catch (error) {
        throw new Error(
          `Image upload failed (${error instanceof PresignedUploadError ? error.status : "unknown"})`,
          { cause: error },
        );
      }

      // SAFETY: every gallery entity's generated update schema accepts
      // `{ id, data: { pendingImageIds } }` — the per-entity shapes only differ
      // in fields this hook never sets, which is why `entityMutationOptionsFactory`
      // stays generic over `E` instead of a hand-written union of the nine call sites.
      const attached = (await updateEntity.mutateAsync({
        id,
        data: { pendingImageIds: [init.imageId] },
      } as GalleryUpdateVariables<E>)) as GalleryUpdateResult<E>;

      // `init.imageId` is the raw upload uuid — `imageOrder`/`removeImageIds`
      // take the public `IMG-` shortcode instead, which only exists once the
      // server hands it back in `attached.images`. Recovered here rather than
      // resolved separately: `associatePendingImages` appends via
      // `nextImageSortOrder` (max + 1), so the image just attached always has
      // the highest sortOrder, and the response orders images by sortOrder —
      // making it reliably the LAST entry.
      const newCode = attached.images.at(-1)!.id;

      if (asCover) {
        // Order off the server's own post-attach list rather than a
        // caller-held snapshot. A stale or filtered list would omit ids, and
        // an omitted id keeps its old sortOrder — on legacy rows that all sit
        // at `0` it would then TIE the new cover at 0, and the relation's
        // `createdAt` tiebreak hands the cover back to the older photo.
        const otherIds = attached.images
          .map((img) => img.id)
          .filter((id) => id !== newCode);
        if (otherIds.length > 0) {
          // SAFETY: see the `pendingImageIds` assertion above — same generic
          // update payload, this time the `imageOrder` write field every
          // gallery entity accepts.
          await updateEntity.mutateAsync({
            id,
            data: { imageOrder: [newCode, ...otherIds] },
          } as GalleryUpdateVariables<E>);
        }
      }

      invalidate();
      return newCode;
    },
    [entityType, uploadImage, updateEntity, invalidate],
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
    async (id: GalleryEntityId<E>, imageId: ImageShortcode): Promise<void> => {
      // SAFETY: see the `pendingImageIds` assertion in `capture` above — same
      // generic update payload, this time the `removeImageIds` write field
      // every gallery entity accepts.
      await updateEntity.mutateAsync({
        id,
        data: { removeImageIds: [imageId] },
      } as GalleryUpdateVariables<E>);
      invalidate();
    },
    [updateEntity, invalidate],
  );

  return {
    capture,
    discardCapture,
    isCapturing: uploadImage.isPending || updateEntity.isPending,
  };
}
