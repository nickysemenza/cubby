import {
  createTRPCRouter,
  protectedProcedure,
  createAppError,
} from "~/server/api/trpc";
import {
  initiateUploadWithoutEntitySchema,
  initiateUploadWithoutEntityResponseSchema,
  getImageByIdSchema,
  imageWithEntitySchema,
  imageListFiltersSchema,
  imageListResponseSchema,
  cullPendingImagesSchema,
  cullPendingImagesResponseSchema,
} from "~/schemas/image";
import {
  initiateImageUploadWithoutEntity,
  getImageById,
  imageList,
  cullPendingImages,
} from "~/server/repo/image";
import { buildPaginatedResponse } from "~/schemas/pagination";

export const imageRouter = createTRPCRouter({
  /**
   * List all images with standard pagination, sorting, and filtering
   */
  list: protectedProcedure
    .input(imageListFiltersSchema)
    .output(imageListResponseSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { data, count } = await imageList(
          ctx.db,
          ctx.organizationId,
          input.filters.searchFilter,
          input.sort,
          input.pagination,
        );
        return buildPaginatedResponse(input.pagination, data, count);
      } catch (error) {
        throw createAppError(
          "IMAGE_LIST_FAILED",
          "Failed to list images",
          error,
        );
      }
    }),

  /**
   * Initiate an image upload
   */
  uploadImage: protectedProcedure
    .input(initiateUploadWithoutEntitySchema)
    .output(initiateUploadWithoutEntityResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        // organizationId is guaranteed by protectedProcedure
        const uploadData = await initiateImageUploadWithoutEntity(
          ctx.db,
          input,
          ctx.organizationId,
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
   * Get an image by ID with entity association information
   */
  getImageById: protectedProcedure
    .input(getImageByIdSchema)
    .output(imageWithEntitySchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getImageById(ctx.db, ctx.organizationId, input.id);
      } catch (error) {
        throw createAppError("IMAGE_GET_FAILED", "Failed to get image", error);
      }
    }),

  /**
   * Cull (delete) pending images that are older than the specified threshold
   */
  cullPendingImages: protectedProcedure
    .input(cullPendingImagesSchema)
    .output(cullPendingImagesResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await cullPendingImages(
          ctx.db,
          ctx.organizationId,
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
