import type { ActorContext } from "@cubby/schemas/context";
import type {
  createFileUploadInput,
  cullPendingImagesSchema,
  getImageByIdSchema,
  importImageFromUrlSchema,
  initiateDocumentUploadSchema,
  initiateUploadWithoutEntitySchema,
  mcpAttachFileInput,
  imageAttachExistingInput,
} from "@cubby/schemas/image";
import type { AppErrorReason } from "@cubby/shared";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { AppError, createAppError } from "~/server/errors/app-error";
import {
  attachExistingImageToEntity,
  markImageUploaded,
} from "~/server/repo/image";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { scheduleImageProcessingJobs } from "~/server/services/image-processing.service";
import {
  attachFileToEntity,
  createFileUpload,
  cullPendingImageStorage,
  importImageFromUrl,
  initiateDocumentUpload,
  initiateImageUploadWithoutEntity,
} from "~/server/services/image-storage.service";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

type MarkUploadedInput = z.output<typeof getImageByIdSchema>;
export const markImageUploadedWorkflow = bindWorkflow(
  workflow<Database, MarkUploadedInput>("image.markUploaded")
    .call("resolveImage", async ({ context }, { input }) =>
      resolveOrThrow(context, "image", input.id),
    )
    .commit("markUploaded", async ({ context }, { resolveImage }) =>
      markImageUploaded(context, resolveImage),
    )
    .commit("scheduleImageProcessing", async ({ context }, { markUploaded }) =>
      // Settings default disabled/paused, so rollout creates no automatic work
      // until the owner explicitly enables it. Durable jobs repair missed wakes.
      scheduleImageProcessingJobs(context, {
        id: markUploaded.id,
        kinds: ["describe_image", "subject_lift"],
        automatic: true,
      }),
    )
    .output(({ markUploaded }) => markUploaded),
  (db: Database, input: MarkUploadedInput) => ({ context: db, input }),
);

const imageFailure =
  (reason: AppErrorReason, message: string, preserveAppError = false) =>
  async (
    _: { context: Database },
    { error }: { error: unknown },
  ): Promise<never> => {
    if (preserveAppError && error instanceof AppError) throw error;
    throw createAppError(reason, message, error);
  };

const imageOperation = <Input, Output>(
  name: string,
  run: (db: Database, input: Input) => Promise<Output>,
  reason: AppErrorReason,
  message: string,
  preserveAppError = false,
) =>
  bindWorkflow(
    workflow<Database, Input>(name)
      .commit("run", async ({ context }, { input }) => run(context, input))
      .output(
        ({ run: result }) => result,
        imageFailure(reason, message, preserveAppError),
      ),
    (db: Database, input: Input) => ({ context: db, input }),
  );

type ImageUploadInput = z.output<typeof initiateUploadWithoutEntitySchema>;
export const initiateImageUploadWorkflow = bindWorkflow(
  workflow<Database, ImageUploadInput>("image.initiateUpload")
    .commit("createUpload", async ({ context }, { input }) =>
      initiateImageUploadWithoutEntity(context, input),
    )
    .output(
      ({ createUpload: result }) => ({
        uploadUrl: result.uploadUrl,
        imageId: result.imageId,
        key: result.key,
        url: result.url,
      }),
      imageFailure("IMAGE_UPLOAD_FAILED", "Failed to initiate upload"),
    ),
  (db: Database, input: ImageUploadInput) => ({ context: db, input }),
);

type DocumentUploadInput = z.output<typeof initiateDocumentUploadSchema>;
export const initiateDocumentUploadWorkflow = bindWorkflow(
  workflow<Database, DocumentUploadInput>("image.initiateDocumentUpload")
    .commit("createUpload", async ({ context }, { input }) =>
      initiateDocumentUpload(context, input),
    )
    .output(
      ({ createUpload: result }) => ({
        uploadUrl: result.uploadUrl,
        imageId: result.imageId,
        key: result.key,
        url: result.url,
      }),
      imageFailure("IMAGE_UPLOAD_FAILED", "Failed to initiate upload"),
    ),
  (db: Database, input: DocumentUploadInput) => ({ context: db, input }),
);

type ImageImportInput = z.output<typeof importImageFromUrlSchema>;
export const importImageFromUrlWorkflow = bindWorkflow(
  workflow<Database, ImageImportInput>("image.importFromUrl")
    .commit("importImage", async ({ context }, { input }) => {
      const request = {
        sourceUrl: input.url,
        filenamePrefix: `${input.entityType ?? "image"}-url-import`,
      };
      const result = await importImageFromUrl(context, request);
      if (!result) throw new Error("Failed to fetch image from URL");
      const filename =
        new URL(request.sourceUrl).pathname.split("/").pop() ||
        `${request.filenamePrefix}.jpg`;
      return {
        imageId: result.imageId,
        key: result.key,
        url: result.url,
        filename,
      };
    })
    .output(
      ({ importImage }) => importImage,
      imageFailure("IMAGE_IMPORT_FAILED", "Failed to import image from URL"),
    ),
  (db: Database, input: ImageImportInput) => ({ context: db, input }),
);

export const attachFileWorkflow = imageOperation(
  "image.attachFile",
  (db: Database, input: z.output<typeof mcpAttachFileInput>) =>
    attachFileToEntity(db, input),
  "IMAGE_UPLOAD_FAILED",
  "Failed to attach file",
  true,
);
export const attachExistingImageWorkflow = bindWorkflow(
  workflow<
    { db: Database; actor: ActorContext },
    z.output<typeof imageAttachExistingInput>
  >("image.attachExisting")
    .commit("attach", async ({ context }, { input }) =>
      attachExistingImageToEntity(context.db, input, context.actor),
    )
    .output(({ attach, input }) => ({
      imageId: input.imageId,
      targetId: input.targetId,
      reused: attach.reused,
    })),
  (
    db: Database,
    actor: ActorContext,
    input: z.output<typeof imageAttachExistingInput>,
  ) => ({ context: { db, actor }, input }),
);
export const createFileUploadWorkflow = imageOperation(
  "image.createFileUpload",
  (db: Database, input: z.output<typeof createFileUploadInput>) =>
    createFileUpload(db, input),
  "IMAGE_UPLOAD_FAILED",
  "Failed to create file upload",
  true,
);
export const cullPendingImagesWorkflow = imageOperation(
  "image.cullPending",
  (db: Database, input: z.output<typeof cullPendingImagesSchema>) =>
    cullPendingImageStorage(db, input.olderThanHours),
  "IMAGE_CULL_FAILED",
  "Failed to cull pending images",
);
