import type {
  createFileUploadInput,
  cullPendingImagesSchema,
  getImageByIdSchema,
  importImageFromUrlSchema,
  initiateDocumentUploadSchema,
  initiateUploadWithoutEntitySchema,
  mcpAttachFileInput,
} from "@cubby/schemas/image";
import type { z } from "zod";
import type { Database } from "~/server/db";
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
export const markImageUploadedWorkflow = async (
  db: Database,
  input: z.output<typeof getImageByIdSchema>,
) => markImageUploaded(db, await resolveOrThrow(db, "image", input.id));
export const initiateImageUploadWorkflow = async (
  db: Database,
  input: z.output<typeof initiateUploadWithoutEntitySchema>,
) => {
  try {
    const result = await initiateImageUploadWithoutEntity(db, input);
    return {
      uploadUrl: result.uploadUrl,
      imageId: result.imageId,
      key: result.key,
      url: result.url,
    };
  } catch (error) {
    throw createAppError(
      "IMAGE_UPLOAD_FAILED",
      "Failed to initiate upload",
      error,
    );
  }
};
export const initiateDocumentUploadWorkflow = async (
  db: Database,
  input: z.output<typeof initiateDocumentUploadSchema>,
) => {
  try {
    const result = await initiateDocumentUpload(db, input);
    return {
      uploadUrl: result.uploadUrl,
      imageId: result.imageId,
      key: result.key,
      url: result.url,
    };
  } catch (error) {
    throw createAppError(
      "IMAGE_UPLOAD_FAILED",
      "Failed to initiate upload",
      error,
    );
  }
};
export const importImageFromUrlWorkflow = async (
  db: Database,
  input: z.output<typeof importImageFromUrlSchema>,
) => {
  try {
    const filenamePrefix = `${input.entityType ?? "image"}-url-import`;
    const result = await importImageFromUrl(db, {
      sourceUrl: input.url,
      filenamePrefix,
    });
    if (!result) throw new Error("Failed to fetch image from URL");
    const filename =
      new URL(input.url).pathname.split("/").pop() || `${filenamePrefix}.jpg`;
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
};
export const attachFileWorkflow = async (
  db: Database,
  input: z.output<typeof mcpAttachFileInput>,
) => {
  try {
    return await attachFileToEntity(db, input);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw createAppError("IMAGE_UPLOAD_FAILED", "Failed to attach file", error);
  }
};
export const createFileUploadWorkflow = async (
  db: Database,
  input: z.output<typeof createFileUploadInput>,
) => {
  try {
    return await createFileUpload(db, input);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw createAppError(
      "IMAGE_UPLOAD_FAILED",
      "Failed to create file upload",
      error,
    );
  }
};
export const cullPendingImagesWorkflow = async (
  db: Database,
  input: z.output<typeof cullPendingImagesSchema>,
) => {
  try {
    return await cullPendingImageStorage(db, input.olderThanHours);
  } catch (error) {
    throw createAppError(
      "IMAGE_CULL_FAILED",
      "Failed to cull pending images",
      error,
    );
  }
};
export const cleanupUnreferencedImagesWorkflow = async (db: Database) => {
  try {
    return await cleanupUnreferencedImageStorage(db);
  } catch (error) {
    throw createAppError(
      "IMAGE_CULL_FAILED",
      "Failed to clean up unreferenced files",
      error,
    );
  }
};
