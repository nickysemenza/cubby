import {
  attachFileResponse,
  createFileUploadInput,
  createFileUploadResponse,
  cullPendingImagesResponseSchema,
  cullPendingImagesSchema,
  getImageByIdSchema,
  imageWithEntitySchema,
  importImageFromUrlResponseSchema,
  importImageFromUrlSchema,
  initiateDocumentUploadSchema,
  initiateUploadWithoutEntityResponseSchema,
  initiateUploadWithoutEntitySchema,
  mcpAttachFileInput,
} from "@cubby/schemas/image";
import {
  createTRPCRouter,
  protectedProcedure,
  strictOutput,
} from "~/server/api/trpc";
import { AppError, createAppError } from "~/server/errors/app-error";
import { markImageUploaded } from "~/server/repo/image";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  attachFileToEntity,
  cleanupUnreferencedImageStorage,
  createFileUpload,
  cullPendingImageStorage,
  importImageFromUrl,
  initiateDocumentUpload,
  initiateImageUploadWithoutEntity,
} from "~/server/services/image-storage.service";

export const imageRouter = createTRPCRouter({
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
    .output(strictOutput(imageWithEntitySchema))
    .mutation(async ({ ctx, input }) => {
      const id = await resolveOrThrow(ctx.db, "image", input.id);
      return await markImageUploaded(ctx.db, id);
    }),

  /**
   * Initiate an image upload
   */
  uploadImage: protectedProcedure
    .input(initiateUploadWithoutEntitySchema)
    .output(strictOutput(initiateUploadWithoutEntityResponseSchema))
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
    .output(strictOutput(initiateUploadWithoutEntityResponseSchema))
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
    .output(strictOutput(importImageFromUrlResponseSchema))
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
    .output(strictOutput(attachFileResponse))
    .mutation(async ({ ctx, input }) => {
      try {
        return await attachFileToEntity(ctx.db, input);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createAppError(
          "IMAGE_UPLOAD_FAILED",
          "Failed to attach file",
          error,
        );
      }
    }),

  /**
   * Stage a local file for `attachFile`: a PENDING row plus a presigned PUT.
   *
   * The two-phase flow the browser already uses, exposed so a non-browser
   * client can reach it. A file on disk has no other route — the server is
   * remote so `url` cannot name it, and base64 is unusable at photo sizes.
   */
  createFileUpload: protectedProcedure
    .input(createFileUploadInput)
    .output(strictOutput(createFileUploadResponse))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createFileUpload(ctx.db, input);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createAppError(
          "IMAGE_UPLOAD_FAILED",
          "Failed to create file upload",
          error,
        );
      }
    }),

  /**
   * Cull (delete) pending images that are older than the specified threshold
   */
  cullPendingImages: protectedProcedure
    .input(cullPendingImagesSchema)
    .output(strictOutput(cullPendingImagesResponseSchema))
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

  /**
   * Delete UPLOADED files nothing references, plus their R2 objects. The
   * fix path for the `unreferencedImages` Problems section.
   */
  cleanupUnreferencedImages: protectedProcedure
    .output(strictOutput(cullPendingImagesResponseSchema))
    .mutation(async ({ ctx }) => {
      try {
        return await cleanupUnreferencedImageStorage(ctx.db);
      } catch (error) {
        throw createAppError(
          "IMAGE_CULL_FAILED",
          "Failed to clean up unreferenced files",
          error,
        );
      }
    }),
});
