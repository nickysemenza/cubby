import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
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
  list: publicProcedure
    .input(imageListFiltersSchema)
    .output(imageListResponseSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { data, count } = await imageList(
          ctx.db,
          input.filters.searchFilter,
          input.sort,
          input.pagination,
        );
        return buildPaginatedResponse(input.pagination, data, count);
      } catch (error) {
        console.error("Error listing images:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to list images",
        });
      }
    }),

  /**
   * Initiate an image upload
   */
  uploadImage: publicProcedure
    .input(initiateUploadWithoutEntitySchema)
    .output(initiateUploadWithoutEntityResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        if (!ctx.projectId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Project ID required",
          });
        }
        const uploadData = await initiateImageUploadWithoutEntity(
          ctx.db,
          input,
          ctx.projectId,
        );

        return {
          uploadUrl: uploadData.uploadUrl,
          imageId: uploadData.imageId,
          key: uploadData.key,
          url: uploadData.url,
        };
      } catch (error) {
        console.error("Error initiating upload:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to initiate upload",
        });
      }
    }),

  /**
   * Get an image by ID with entity association information
   */
  getImageById: publicProcedure
    .input(getImageByIdSchema)
    .output(imageWithEntitySchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getImageById(ctx.db, input.id);
      } catch (error) {
        console.error("Error getting image by ID:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to get image",
        });
      }
    }),

  /**
   * Cull (delete) pending images that are older than the specified threshold
   */
  cullPendingImages: publicProcedure
    .input(cullPendingImagesSchema)
    .output(cullPendingImagesResponseSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await cullPendingImages(ctx.db, input.olderThanHours);

        return result;
      } catch (error) {
        console.error("Error culling pending images:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to cull pending images",
        });
      }
    }),
});
