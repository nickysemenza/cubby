import {
  type imageBrowserDeleteInput,
  imageBrowserDeleteOut,
  type imageBrowserListInput,
  imageBrowserListOut,
  type imageBrowserUpdateInput,
  imageWithEntitySchema,
  type projectImageSummariesInput,
  projectImageSummariesOut,
} from "@cubby/schemas/image";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import * as imageBrowser from "~/server/image-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const listImagesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof imageBrowserListInput>)
  .handler(
    async ({ data, context }) =>
      await imageBrowser.listImages({
        data,
        request: context.startOperation,
      }),
  );

const getImageDetailTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as { id: string })
  .handler(
    async ({ data, context }) =>
      await imageBrowser.getImageDetail({
        data,
        request: context.startOperation,
      }),
  );

const updateImageTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof imageBrowserUpdateInput>,
  )
  .handler(
    async ({ data, context }) =>
      await imageBrowser.updateImage({
        data,
        request: context.startOperation,
      }),
  );

const deleteImagesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof imageBrowserDeleteInput>,
  )
  .handler(
    async ({ data, context }) =>
      await imageBrowser.deleteImages({
        data,
        request: context.startOperation,
      }),
  );

const getProjectImageSummariesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof projectImageSummariesInput>,
  )
  .handler(
    async ({ data, context }) =>
      await imageBrowser.getProjectImageSummaries({
        data,
        request: context.startOperation,
      }),
  );

const imageListQueryKey = (input: z.input<typeof imageBrowserListInput>) =>
  [["image", "list"], { input }] as const;

export const imageListQueryOptions = (
  input: z.input<typeof imageBrowserListInput>,
) =>
  queryOptions({
    queryKey: imageListQueryKey(input),
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "image.list",
        entity: "image",
        input,
        call: async (headers) =>
          imageBrowserListOut.parse(
            unwrapStartOperationResult(
              "image.list",
              await listImagesTransport({ data: input, signal, headers }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "image.list",
      entity: "image",
      observedByTransport: true,
    },
  });

export const imageDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [["image", "detail"], { shortcode: id }] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "image.detail",
        entity: "image",
        input: { id },
        call: async (headers) =>
          imageWithEntitySchema.nullable().parse(
            unwrapStartOperationResult(
              "image.detail",
              await getImageDetailTransport({
                data: { id },
                signal,
                headers,
              }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "image.detail",
      entity: "image",
      observedByTransport: true,
    },
  });

export const imageUpdateMutationOptions = () =>
  mutationOptions({
    mutationKey: [["image", "update"]] as const,
    mutationFn: async (input: z.input<typeof imageBrowserUpdateInput>) =>
      await observedStartCall({
        operation: "image.update",
        kind: "mutation",
        entity: "image",
        input,
        call: async (headers) => {
          const result = imageWithEntitySchema.parse(
            unwrapStartOperationResult(
              "image.update",
              await updateImageTransport({ data: input, headers }),
            ),
          );
          markFreshReads();
          return result;
        },
      }),
    meta: {
      transport: "start",
      operation: "image.update",
      entity: "image",
      observedByTransport: true,
    },
  });

export const imageDeleteMutationOptions = () =>
  mutationOptions({
    mutationKey: [["image", "delete"]] as const,
    mutationFn: async (input: z.input<typeof imageBrowserDeleteInput>) =>
      await observedStartCall({
        operation: "image.delete",
        kind: "mutation",
        entity: "image",
        input,
        call: async (headers) => {
          const result = imageBrowserDeleteOut.parse(
            unwrapStartOperationResult(
              "image.delete",
              await deleteImagesTransport({ data: input, headers }),
            ),
          );
          markFreshReads();
          return result;
        },
      }),
    meta: {
      transport: "start",
      operation: "image.delete",
      entity: "image",
      observedByTransport: true,
    },
  });

export const projectImageSummariesQueryOptions = (
  input: z.input<typeof projectImageSummariesInput>,
) =>
  queryOptions({
    queryKey: [
      ["image", "projectSummaries"],
      { projectIds: input.projectIds },
    ] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "image.projectSummaries",
        input,
        call: async (headers) =>
          projectImageSummariesOut.parse(
            unwrapStartOperationResult(
              "image.projectSummaries",
              await getProjectImageSummariesTransport({
                data: input,
                signal,
                headers,
              }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "image.projectSummaries",
      observedByTransport: true,
    },
    staleTime: 5 * 60 * 1000,
  });

export type ProjectImageSummaries = z.output<typeof projectImageSummariesOut>;
