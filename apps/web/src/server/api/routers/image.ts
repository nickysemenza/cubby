import {
  type ProjectShortcode,
  projectShortcode,
  unsafeProjectId,
} from "@cubby/schemas/identifiers";
import {
  attachFileResponse,
  cullPendingImagesResponseSchema,
  cullPendingImagesSchema,
  getImageByIdSchema,
  imageListFiltersSchema,
  imageSortableFields,
  imageUpdateInput,
  imageWithEntitySchema,
  importImageFromUrlResponseSchema,
  importImageFromUrlSchema,
  initiateDocumentUploadSchema,
  initiateUploadWithoutEntityResponseSchema,
  initiateUploadWithoutEntitySchema,
  mcpAttachFileInput,
} from "@cubby/schemas/image";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createDeleteProcedure,
  createEntityListProcedure,
} from "~/server/api/crud-factory";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createAppError } from "~/server/errors/app-error";
import {
  getImageById,
  getImagesByProjectIds,
  imageList,
  markImageUploaded,
  updateImage,
} from "~/server/repo/image";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import {
  attachFileToEntity,
  cullPendingImageStorage,
  deleteImagesWithStorage,
  importImageFromUrl,
  initiateDocumentUpload,
  initiateImageUploadWithoutEntity,
} from "~/server/services/image-storage.service";

/** Minimal image shape for gallery/cover display — mirrors `MinimalImage` in
 * EntityImageList/EntityHero (id, url, filename only). */
const projectImageSummary = z.object({
  id: z.string(),
  url: z.url(),
  filename: z.string(),
});

// List images with standard pagination, sorting, and filtering. Uses the crud
// factory so the response carries the per-record error-context wrapper every
// other entity list uses.
const { list } = createEntityListProcedure({
  schemas: {
    output: imageWithEntitySchema,
    filters: imageListFiltersSchema,
    sort: {
      sortableFields: imageSortableFields,
      defaultSort: "createdAt",
    },
  },
  repository: {
    list: async (services, filters, sort, pagination) => {
      return await imageList(services.db, filters.nameFilter, sort, pagination);
    },
  },
  entityName: "image",
});

/**
 * Hard-delete images (rows + associations + R2 objects).
 *
 * `Image` has a `deletedAt` column like every other entity; it's just never set.
 * Images are deleted for real rather than tombstoned — an image with no owning
 * entity has no use once removed — so this really removes the row and its R2
 * object. Shaped by `createDeleteProcedure` like every other entity delete, so the list
 * page's `deletable` config and bulk selection work unchanged; there are no
 * mutation side-effects to run (images carry no embedding / derived data).
 */
const deleteItem = createDeleteProcedure(async (services, ids) => {
  await deleteImagesWithStorage(services.db, ids);
  return undefined;
});

export const imageRouter = createTRPCRouter({
  list,
  delete: deleteItem,

  /**
   * Rename an image. `filename` is the only safely user-editable column — see
   * `imageUpdateInput`. Hand-written rather than `createUpdateProcedure`
   * (private to crud-factory), but matches its input/output shape exactly so
   * `useUpdateMutation`/`createNameColumn`'s editable wiring works unchanged.
   *
   * No try/catch wrapper: `updateImage`'s repo query can throw IMAGE_NOT_FOUND
   * for a stale/deleted id (via the re-read in `getImageById`), which should
   * propagate as a 4xx rather than be rewrapped into a 500 — same reasoning as
   * `getByID` above.
   */
  update: protectedProcedure
    .input(z.object({ id: z.string(), data: imageUpdateInput }))
    .output(imageWithEntitySchema)
    .mutation(async ({ ctx, input }) => {
      return await updateImage(ctx.db, input.id, input.data);
    }),

  /**
   * Flip a PENDING image to UPLOADED once the browser's presigned PUT to R2
   * succeeds. Required for the standalone `/images` upload dialog: unlike
   * entity-form uploads (finalized by `associatePendingImages` on save) or the
   * cookbook cover path, a standalone upload has no entity save step to flip
   * status — without this call it stays PENDING forever and is later culled
   * (see `markImageUploaded`'s doc comment in repo/image.ts).
   */
  markUploaded: protectedProcedure
    .input(getImageByIdSchema)
    .output(imageWithEntitySchema)
    .mutation(async ({ ctx, input }) => {
      return await markImageUploaded(ctx.db, input.id);
    }),

  /**
   * Initiate an image upload
   */
  uploadImage: protectedProcedure
    .input(initiateUploadWithoutEntitySchema)
    .output(initiateUploadWithoutEntityResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const uploadData = await initiateImageUploadWithoutEntity(
          ctx.db,
          input,
        );

        return {
          uploadUrl: uploadData.uploadUrl,
          imageId: uploadData.imageId,
          key: uploadData.key,
          url: uploadData.url,
        };
      } catch (error) {
        throw createAppError(
          "IMAGE_UPLOAD_FAILED",
          "Failed to initiate upload",
          error,
        );
      }
    }),

  /**
   * Initiate a document (PDF manual) upload. Same pending-image machinery as
   * uploadImage — only the accepted content types and key layout differ.
   */
  uploadDocument: protectedProcedure
    .input(initiateDocumentUploadSchema)
    .output(initiateUploadWithoutEntityResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const uploadData = await initiateDocumentUpload(ctx.db, input);

        return {
          uploadUrl: uploadData.uploadUrl,
          imageId: uploadData.imageId,
          key: uploadData.key,
          url: uploadData.url,
        };
      } catch (error) {
        throw createAppError(
          "IMAGE_UPLOAD_FAILED",
          "Failed to initiate upload",
          error,
        );
      }
    }),

  /**
   * Import an image from an external URL
   */
  importFromUrl: protectedProcedure
    .input(importImageFromUrlSchema)
    .output(importImageFromUrlResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const filenamePrefix = `${input.entityType ?? "image"}-url-import`;
        const result = await importImageFromUrl(ctx.db, {
          sourceUrl: input.url,
          filenamePrefix,
        });

        if (!result) {
          throw new Error("Failed to fetch image from URL");
        }

        // Extract filename from URL path, falling back to the prefix
        const urlPath = new URL(input.url).pathname;
        const filename = urlPath.split("/").pop() || `${filenamePrefix}.jpg`;

        return {
          imageId: result.imageId,
          key: result.key,
          url: result.url,
          filename,
        };
      } catch (error) {
        throw createAppError(
          "IMAGE_IMPORT_FAILED",
          "Failed to import image from URL",
          error,
        );
      }
    }),

  /**
   * Attach a file (base64 bytes or an external URL) to an entity and store it
   * in R2. Backs the MCP `attach_file` tool. Validation errors from the service
   * are already typed TRPCErrors (4xx) — rethrow them; only wrap genuinely
   * unexpected failures (R2/DB) into a 500.
   */
  attachFile: protectedProcedure
    .input(mcpAttachFileInput)
    .output(attachFileResponse)
    .mutation(async ({ ctx, input }) => {
      try {
        return await attachFileToEntity(ctx.db, input);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw createAppError(
          "IMAGE_UPLOAD_FAILED",
          "Failed to attach file",
          error,
        );
      }
    }),

  /**
   * Get an image by ID with entity association information.
   *
   * No try/catch wrapper: the repo throws IMAGE_NOT_FOUND (→ tRPC NOT_FOUND, an
   * expected 4xx) for a stale/deleted id, which should propagate rather than be
   * rewrapped into a 500 that hits Sentry.
   */
  getByID: protectedProcedure
    .input(getImageByIdSchema)
    .output(imageWithEntitySchema)
    .query(async ({ ctx, input }) => {
      return await getImageById(ctx.db, input.id);
    }),

  /**
   * Images for a set of projects, grouped by project id and ordered
   * cover-first — backs the projects dashboard's card covers and the project
   * detail page's image gallery (projects have no `getByID` images field of
   * their own; see repo/image.ts's `getImagesByProjectIds`).
   */
  imagesByProjectIds: protectedProcedure
    .input(z.object({ projectIds: z.array(projectShortcode) }))
    .output(z.record(z.string(), z.array(projectImageSummary)))
    .query(async ({ ctx, input }) => {
      const resolved = await resolveLiveShortcodes(
        ctx.db,
        input.projectIds,
        "project",
      );
      const missing = input.projectIds.find((id) => !resolved.has(id));
      if (missing) {
        throw createAppError(
          "PROJECT_NOT_FOUND",
          `Project ${missing} not found`,
        );
      }

      const shortcodeByEntityId = new Map<string, ProjectShortcode>();
      const entityIds = input.projectIds.map((shortcode) => {
        const entityId = resolved.get(shortcode)!;
        shortcodeByEntityId.set(entityId, shortcode);
        return unsafeProjectId(entityId);
      });
      const imagesByEntityId = await getImagesByProjectIds(ctx.db, entityIds);

      return Object.fromEntries(
        Object.entries(imagesByEntityId).flatMap(([entityId, images]) => {
          const shortcode = shortcodeByEntityId.get(entityId);
          return shortcode ? [[shortcode, images]] : [];
        }),
      );
    }),

  /**
   * Cull (delete) pending images that are older than the specified threshold
   */
  cullPendingImages: protectedProcedure
    .input(cullPendingImagesSchema)
    .output(cullPendingImagesResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await cullPendingImageStorage(
          ctx.db,
          input.olderThanHours,
        );

        return result;
      } catch (error) {
        throw createAppError(
          "IMAGE_CULL_FAILED",
          "Failed to cull pending images",
          error,
        );
      }
    }),
});
