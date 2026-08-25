import {
  cullPendingImagesResponseSchema,
  type cullPendingImagesSchema,
  type getImageByIdSchema,
  imageWithEntitySchema,
  importImageFromUrlResponseSchema,
  type importImageFromUrlSchema,
  type initiateDocumentUploadSchema,
  initiateUploadWithoutEntityResponseSchema,
  type initiateUploadWithoutEntitySchema,
} from "@cubby/schemas/image";
import {
  mutationOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import {
  type StartOperation,
  startOperation,
} from "~/integrations/tanstack-query/start-transport";
import * as browser from "~/server/image-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const markUploadedTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof getImageByIdSchema>)
  .handler(({ data, context }) =>
    browser.markImageUploadedForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const uploadImageTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof initiateUploadWithoutEntitySchema>,
  )
  .handler(({ data, context }) =>
    browser.initiateImageUploadForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const uploadDocumentTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof initiateDocumentUploadSchema>)
  .handler(({ data, context }) =>
    browser.initiateDocumentUploadForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const importFromUrlTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof importImageFromUrlSchema>)
  .handler(({ data, context }) =>
    browser.importImageFromUrlForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const cullPendingImagesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof cullPendingImagesSchema>)
  .handler(({ data, context }) =>
    browser.cullPendingImagesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const cleanupUnreferencedImagesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.cleanupUnreferencedImagesForBrowser({
      request: context.startOperation,
    }),
  );

const markUploadedOperation = startOperation({
  operation: "image.markUploaded",
  kind: "mutation",
  transport: (data: z.input<typeof getImageByIdSchema>, { headers }) =>
    markUploadedTransport({ data, headers }),
  parse: (result) => imageWithEntitySchema.parse(result),
});
const uploadImageOperation = startOperation({
  operation: "image.uploadImage",
  kind: "mutation",
  transport: (
    data: z.input<typeof initiateUploadWithoutEntitySchema>,
    { headers },
  ) => uploadImageTransport({ data, headers }),
  parse: (result) => initiateUploadWithoutEntityResponseSchema.parse(result),
});
const uploadDocumentOperation = startOperation({
  operation: "image.uploadDocument",
  kind: "mutation",
  transport: (
    data: z.input<typeof initiateDocumentUploadSchema>,
    { headers },
  ) => uploadDocumentTransport({ data, headers }),
  parse: (result) => initiateUploadWithoutEntityResponseSchema.parse(result),
});
const importFromUrlOperation = startOperation({
  operation: "image.importFromUrl",
  kind: "mutation",
  transport: (data: z.input<typeof importImageFromUrlSchema>, { headers }) =>
    importFromUrlTransport({ data, headers }),
  parse: (result) => importImageFromUrlResponseSchema.parse(result),
});
const cullPendingImagesOperation = startOperation({
  operation: "image.cullPendingImages",
  kind: "mutation",
  transport: (data: z.input<typeof cullPendingImagesSchema>, { headers }) =>
    cullPendingImagesTransport({ data, headers }),
  parse: (result) => cullPendingImagesResponseSchema.parse(result),
});
const cleanupUnreferencedImagesOperation = startOperation({
  operation: "image.cleanupUnreferencedImages",
  kind: "mutation",
  transport: (_: undefined, { headers }) =>
    cleanupUnreferencedImagesTransport({ headers }),
  parse: (result) => cullPendingImagesResponseSchema.parse(result),
});

const mutation = <I, O>(
  key: string,
  operation: StartOperation<I, O>,
  options?: UseMutationOptions<O, Error, I>,
) =>
  mutationOptions({
    mutationKey: [["image", key]] as const,
    meta: operation.meta,
    mutationFn: async (input: I) => {
      return operation.call(input);
    },
    ...options,
  });
export const markImageUploadedMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof imageWithEntitySchema>,
    Error,
    z.input<typeof getImageByIdSchema>
  >,
) => mutation("markUploaded", markUploadedOperation, options);
export const uploadImageMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof initiateUploadWithoutEntityResponseSchema>,
    Error,
    z.input<typeof initiateUploadWithoutEntitySchema>
  >,
) => mutation("uploadImage", uploadImageOperation, options);
export const uploadDocumentMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof initiateUploadWithoutEntityResponseSchema>,
    Error,
    z.input<typeof initiateDocumentUploadSchema>
  >,
) => mutation("uploadDocument", uploadDocumentOperation, options);
export const importImageFromUrlMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof importImageFromUrlResponseSchema>,
    Error,
    z.input<typeof importImageFromUrlSchema>
  >,
) => mutation("importFromUrl", importFromUrlOperation, options);
export const cullPendingImagesMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof cullPendingImagesResponseSchema>,
    Error,
    z.input<typeof cullPendingImagesSchema>
  >,
) => mutation("cullPendingImages", cullPendingImagesOperation, options);
export const cleanupUnreferencedImagesMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof cullPendingImagesResponseSchema>,
    Error,
    undefined
  >,
) =>
  mutation(
    "cleanupUnreferencedImages",
    cleanupUnreferencedImagesOperation,
    options,
  );
export const cullPendingImages = (
  input: z.input<typeof cullPendingImagesSchema>,
) => cullPendingImagesOperation.call(input);
