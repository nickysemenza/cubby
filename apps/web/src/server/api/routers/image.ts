import { projectId } from "@cubby/schemas/identifiers";
import {
  cullPendingImagesResponseSchema,
  cullPendingImagesSchema,
  getImageByIdSchema,
  imageListFiltersSchema,
  imageSortableFields,
  imageWithEntitySchema,
  importImageFromUrlResponseSchema,
  importImageFromUrlSchema,
  initiateDocumentUploadSchema,
  initiateUploadWithoutEntityResponseSchema,
  initiateUploadWithoutEntitySchema,
} from "@cubby/schemas/image";
import { z } from "zod";
import { createEntityListProcedure } from "~/server/api/crud-factory";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createAppError } from "~/server/errors/app-error";
import {
  getImageById,
  getImagesByProjectIds,
  imageList,
} from "~/server/repo/image";
import {
  cullPendingImageStorage,
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

export const imageRouter = createTRPCRouter({
  list,

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
        const filenamePrefix = `${input.entityType}-url-import`;
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
    .input(z.object({ projectIds: z.array(projectId) }))
    .output(z.record(z.string(), z.array(projectImageSummary)))
    .query(async ({ ctx, input }) => {
      return await getImagesByProjectIds(ctx.db, input.projectIds);
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
