import {
  cullPendingImagesResponseSchema,
  cullPendingImagesSchema,
  getImageByIdSchema,
  imageListFiltersSchema,
  imageSortableFields,
  imageWithEntitySchema,
  importImageFromUrlResponseSchema,
  importImageFromUrlSchema,
  initiateUploadWithoutEntityResponseSchema,
  initiateUploadWithoutEntitySchema,
} from "@cubby/schemas/image";
import { createEntityListProcedure } from "~/server/api/crud-factory";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createAppError } from "~/server/errors/app-error";
import { getImageById, imageList } from "~/server/repo/image";
import {
  cullPendingImageStorage,
  importImageFromUrl,
  initiateImageUploadWithoutEntity,
} from "~/server/services/image-storage.service";

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
