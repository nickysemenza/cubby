import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import {
  imageShortcode,
  type ProjectShortcode,
  projectShortcode,
} from "@cubby/schemas/identifiers";
import {
  attachFileResponse,
  createFileUploadInput,
  createFileUploadResponse,
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
import {
  createPaginatedResponseSchemaWithContext,
  createSortPaginationFields,
  type PaginationParams,
  type SortInput,
} from "@cubby/schemas/pagination";
import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  strictOutput,
} from "~/server/api/trpc";
import { executeEntity } from "~/server/entity-kernel";
import { AppError, createAppError } from "~/server/errors/app-error";
import { getImagesByProjectIds, markImageUploaded } from "~/server/repo/image";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  attachFileToEntity,
  cleanupUnreferencedImageStorage,
  createFileUpload,
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

const list = protectedProcedure
  .input(
    z.object({
      filters: imageListFiltersSchema,
      ...createSortPaginationFields({
        sortableFields: imageSortableFields,
        defaultSort: "createdAt",
      }),
    }),
  )
  .output(
    strictOutput(
      createPaginatedResponseSchemaWithContext(imageWithEntitySchema, "image"),
    ),
  )
  .query(async ({ ctx, input }) => {
    const result = await executeEntity(ctx, {
      action: "list",
      entity: "image",
      filters: input.filters,
      sort: input.sort as SortInput,
      pagination: input.pagination as PaginationParams,
      groupBy: input.groupBy,
    });
    if (result.action !== "list")
      throw new Error("Entity kernel returned the wrong action");
    return {
      items: z.array(imageWithEntitySchema).parse(result.items),
      meta: result.meta,
    };
  });

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(imageShortcode).min(1).max(500) }))
  .output(
    strictOutput(
      z.object({
        deleted: z.number().int().nonnegative(),
        sideEffects: mutationSideEffectsSchema,
      }),
    ),
  )
  .mutation(async ({ ctx, input }) => {
    const result = await executeEntity(ctx, {
      action: "delete",
      entity: "image",
      ids: input.ids,
    });
    if (result.action !== "delete")
      throw new Error("Entity kernel returned the wrong action");
    return { deleted: result.deleted, sideEffects: result.sideEffects };
  });

export const imageRouter = createTRPCRouter({
  list,
  delete: deleteItem,

  update: protectedProcedure
    .input(z.object({ id: imageShortcode, data: imageUpdateInput }))
    .output(strictOutput(imageWithEntitySchema))
    .mutation(async ({ ctx, input }) => {
      const result = await executeEntity(ctx, {
        action: "update",
        entity: "image",
        id: input.id,
        data: input.data,
      });
      if (result.action !== "update")
        throw new Error("Entity kernel returned the wrong action");
      return imageWithEntitySchema.parse(result.item);
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

  getByID: protectedProcedure
    .input(getImageByIdSchema)
    .output(strictOutput(imageWithEntitySchema))
    .query(async ({ ctx, input }) => {
      const result = await executeEntity(ctx, {
        action: "get",
        entity: "image",
        id: input.id,
        missing: "error",
      });
      if (result.action !== "get" || result.item === null)
        throw new Error("Entity kernel returned the wrong action");
      return imageWithEntitySchema.parse(result.item);
    }),

  /**
   * Images for a set of projects, grouped by project id and ordered
   * cover-first — backs the projects dashboard's card covers and the project
   * detail page's image gallery (projects have no `getByID` images field of
   * their own; see repo/image.ts's `getImagesByProjectIds`).
   */
  imagesByProjectIds: protectedProcedure
    .input(z.object({ projectIds: z.array(projectShortcode) }))
    .output(strictOutput(z.record(z.string(), z.array(projectImageSummary))))
    .query(async ({ ctx, input }) => {
      const entityIds = await resolveAllOrThrow(
        ctx.db,
        "project",
        input.projectIds,
      );
      const shortcodeByEntityId = new Map<string, ProjectShortcode>(
        input.projectIds.map((shortcode, i) => [entityIds[i]!, shortcode]),
      );
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
