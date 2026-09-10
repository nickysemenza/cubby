import type { ImageId } from "@cubby/schemas/identifiers";
import type {
  createFileUploadInput,
  cullPendingImagesSchema,
  getImageByIdSchema,
  importImageFromUrlSchema,
  initiateDocumentUploadSchema,
  initiateUploadWithoutEntitySchema,
  mcpAttachFileInput,
} from "@cubby/schemas/image";
import type { AppErrorReason } from "@cubby/shared";
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
import {
  bindWorkflow,
  callStep,
  committedCallStep,
  defineWorkflow,
  defineWorkflowFunction,
  workflowInput,
  mapWorkflowValue,
} from "~/server/workflow-runtime";

type MarkUploadedInput = z.output<typeof getImageByIdSchema>;
const imageToMark = callStep({
  name: "resolveImage",
  input: workflowInput<MarkUploadedInput>(),
  fn: defineWorkflowFunction<Database, MarkUploadedInput, ImageId>(
    "image.resolveUploadedSubject",
    async ({ context }, input) => resolveOrThrow(context, "image", input.id),
  ),
});
const markUploaded = committedCallStep({
  name: "markUploaded",
  input: imageToMark.output,
  fn: defineWorkflowFunction<
    Database,
    ImageId,
    Awaited<ReturnType<typeof markImageUploaded>>
  >("image.markUploaded", async ({ context }, id) =>
    markImageUploaded(context, id),
  ),
});
export const markImageUploadedWorkflow = bindWorkflow(
  defineWorkflow({
    name: "image.markUploaded",
    steps: [imageToMark, markUploaded],
    output: markUploaded.output,
  }),
  (db: Database, input: MarkUploadedInput) => ({ context: db, input }),
);

const imageFailure = <Input>(
  reason: AppErrorReason,
  message: string,
  preserveAppError = false,
) =>
  defineWorkflowFunction<Database, { input: Input; error: unknown }, never>(
    `image.failure.${reason}.${preserveAppError ? "preserve" : "translate"}`,
    async (_, { error }) => {
      if (preserveAppError && error instanceof AppError) throw error;
      throw createAppError(reason, message, error);
    },
  );

const imageOperation = <Input, Output>(
  name: string,
  run: (db: Database, input: Input) => Promise<Output>,
  failure: ReturnType<typeof imageFailure<Input>>,
) => {
  const operation = committedCallStep({
    name: "run",
    input: workflowInput<Input>(),
    fn: defineWorkflowFunction<Database, Input, Output>(
      name,
      ({ context }, input) => run(context, input),
    ),
  });
  return bindWorkflow(
    defineWorkflow({
      name,
      steps: [operation],
      output: operation.output,
      failure,
    }),
    (db: Database, input: Input) => ({ context: db, input }),
  );
};

type ImageUploadInput = z.output<typeof initiateUploadWithoutEntitySchema>;
const imageUpload = committedCallStep({
  name: "createUpload",
  input: workflowInput<ImageUploadInput>(),
  fn: defineWorkflowFunction<
    Database,
    ImageUploadInput,
    Awaited<ReturnType<typeof initiateImageUploadWithoutEntity>>
  >("image.createUpload", ({ context }, input) =>
    initiateImageUploadWithoutEntity(context, input),
  ),
});
export const initiateImageUploadWorkflow = bindWorkflow(
  defineWorkflow({
    name: "image.initiateUpload",
    steps: [imageUpload],
    output: mapWorkflowValue(
      imageUpload.output,
      ({ uploadUrl, imageId, key, url }) => ({ uploadUrl, imageId, key, url }),
    ),
    failure: imageFailure<ImageUploadInput>(
      "IMAGE_UPLOAD_FAILED",
      "Failed to initiate upload",
    ),
  }),
  (db: Database, input: ImageUploadInput) => ({ context: db, input }),
);

type DocumentUploadInput = z.output<typeof initiateDocumentUploadSchema>;
const documentUpload = committedCallStep({
  name: "createUpload",
  input: workflowInput<DocumentUploadInput>(),
  fn: defineWorkflowFunction<
    Database,
    DocumentUploadInput,
    Awaited<ReturnType<typeof initiateDocumentUpload>>
  >("image.createDocumentUpload", ({ context }, input) =>
    initiateDocumentUpload(context, input),
  ),
});
export const initiateDocumentUploadWorkflow = bindWorkflow(
  defineWorkflow({
    name: "image.initiateDocumentUpload",
    steps: [documentUpload],
    output: mapWorkflowValue(
      documentUpload.output,
      ({ uploadUrl, imageId, key, url }) => ({ uploadUrl, imageId, key, url }),
    ),
    failure: imageFailure<DocumentUploadInput>(
      "IMAGE_UPLOAD_FAILED",
      "Failed to initiate upload",
    ),
  }),
  (db: Database, input: DocumentUploadInput) => ({ context: db, input }),
);

type ImageImportInput = z.output<typeof importImageFromUrlSchema>;
const imageImportRequest = mapWorkflowValue(
  workflowInput<ImageImportInput>(),
  (input) => ({
    sourceUrl: input.url,
    filenamePrefix: `${input.entityType ?? "image"}-url-import`,
  }),
);
type ImageImportRequest = ReturnType<typeof imageImportRequest.resolve>;
const importedImage = committedCallStep({
  name: "importImage",
  input: imageImportRequest,
  fn: defineWorkflowFunction<
    Database,
    ImageImportRequest,
    {
      request: ImageImportRequest;
      result: Awaited<ReturnType<typeof importImageFromUrl>>;
    }
  >("image.importFromUrl", async ({ context }, request) => ({
    request,
    result: await importImageFromUrl(context, request),
  })),
});
export const importImageFromUrlWorkflow = bindWorkflow(
  defineWorkflow({
    name: "image.importFromUrl",
    steps: [importedImage],
    output: mapWorkflowValue(importedImage.output, ({ request, result }) => {
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
    }),
    failure: imageFailure<ImageImportInput>(
      "IMAGE_IMPORT_FAILED",
      "Failed to import image from URL",
    ),
  }),
  (db: Database, input: ImageImportInput) => ({ context: db, input }),
);

export const attachFileWorkflow = imageOperation(
  "image.attachFile",
  (db: Database, input: z.output<typeof mcpAttachFileInput>) =>
    attachFileToEntity(db, input),
  imageFailure("IMAGE_UPLOAD_FAILED", "Failed to attach file", true),
);
export const createFileUploadWorkflow = imageOperation(
  "image.createFileUpload",
  (db: Database, input: z.output<typeof createFileUploadInput>) =>
    createFileUpload(db, input),
  imageFailure("IMAGE_UPLOAD_FAILED", "Failed to create file upload", true),
);
export const cullPendingImagesWorkflow = imageOperation(
  "image.cullPending",
  (db: Database, input: z.output<typeof cullPendingImagesSchema>) =>
    cullPendingImageStorage(db, input.olderThanHours),
  imageFailure("IMAGE_CULL_FAILED", "Failed to cull pending images"),
);
const cleanupImages = imageOperation<
  undefined,
  Awaited<ReturnType<typeof cleanupUnreferencedImageStorage>>
>(
  "image.cleanupUnreferenced",
  cleanupUnreferencedImageStorage,
  imageFailure("IMAGE_CULL_FAILED", "Failed to clean up unreferenced files"),
);
export const cleanupUnreferencedImagesWorkflow = bindWorkflow(
  cleanupImages.definition,
  (db: Database) => ({ context: db, input: undefined }),
);
