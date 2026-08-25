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
import { startOperation } from "~/integrations/tanstack-query/start-transport";
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

const imageListOperation = startOperation<
  z.input<typeof imageBrowserListInput>,
  z.output<typeof imageBrowserListOut>
>({
  operation: "image.list",
  entity: "image",
  transport: (data, { signal, headers }) =>
    listImagesTransport({ data, signal, headers }),
  parse: (result) => imageBrowserListOut.parse(result),
});

const imageDetailOperation = startOperation<
  { id: string },
  z.output<typeof imageWithEntitySchema> | null
>({
  operation: "image.detail",
  entity: "image",
  transport: (data, { signal, headers }) =>
    getImageDetailTransport({ data, signal, headers }),
  parse: (result) => imageWithEntitySchema.nullable().parse(result),
});

const imageUpdateOperation = startOperation<
  z.input<typeof imageBrowserUpdateInput>,
  z.output<typeof imageWithEntitySchema>
>({
  operation: "image.update",
  kind: "mutation",
  entity: "image",
  transport: (data, { headers }) => updateImageTransport({ data, headers }),
  parse: (result) => imageWithEntitySchema.parse(result),
});

const imageDeleteOperation = startOperation<
  z.input<typeof imageBrowserDeleteInput>,
  z.output<typeof imageBrowserDeleteOut>
>({
  operation: "image.delete",
  kind: "mutation",
  entity: "image",
  transport: (data, { headers }) => deleteImagesTransport({ data, headers }),
  parse: (result) => imageBrowserDeleteOut.parse(result),
});

const projectImageSummariesOperation = startOperation<
  z.input<typeof projectImageSummariesInput>,
  z.output<typeof projectImageSummariesOut>
>({
  operation: "image.projectSummaries",
  transport: (data, { signal, headers }) =>
    getProjectImageSummariesTransport({ data, signal, headers }),
  parse: (result) => projectImageSummariesOut.parse(result),
});

const imageListQueryKey = (input: z.input<typeof imageBrowserListInput>) =>
  [["image", "list"], { input }] as const;

export const imageListQueryOptions = (
  input: z.input<typeof imageBrowserListInput>,
) =>
  queryOptions({
    queryKey: imageListQueryKey(input),
    meta: imageListOperation.meta,
    queryFn: ({ signal }) => imageListOperation.call(input, { signal }),
  });

export const imageDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [["image", "detail"], { shortcode: id }] as const,
    meta: imageDetailOperation.meta,
    queryFn: ({ signal }) => imageDetailOperation.call({ id }, { signal }),
  });

export const imageUpdateMutationOptions = () =>
  mutationOptions({
    mutationKey: [["image", "update"]] as const,
    mutationFn: async (input: z.input<typeof imageBrowserUpdateInput>) => {
      const result = await imageUpdateOperation.call(input);
      return result;
    },
    meta: imageUpdateOperation.meta,
  });

export const imageDeleteMutationOptions = () =>
  mutationOptions({
    mutationKey: [["image", "delete"]] as const,
    mutationFn: async (input: z.input<typeof imageBrowserDeleteInput>) => {
      const result = await imageDeleteOperation.call(input);
      return result;
    },
    meta: imageDeleteOperation.meta,
  });

export const projectImageSummariesQueryOptions = (
  input: z.input<typeof projectImageSummariesInput>,
) =>
  queryOptions({
    queryKey: [
      ["image", "projectSummaries"],
      { projectIds: input.projectIds },
    ] as const,
    meta: projectImageSummariesOperation.meta,
    queryFn: ({ signal }) =>
      projectImageSummariesOperation.call(input, { signal }),
    staleTime: 5 * 60 * 1000,
  });

export type ProjectImageSummaries = z.output<typeof projectImageSummariesOut>;
