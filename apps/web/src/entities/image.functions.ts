import {
  imageBrowserDeleteInput,
  imageBrowserDeleteOut,
  imageBrowserListInput,
  imageBrowserListOut,
  imageBrowserUpdateInput,
  imageWithEntitySchema,
  projectImageSummariesInput,
  projectImageSummariesOut,
} from "@cubby/schemas/image";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const image = defineOperationDomain("image", {
  list: query({
    input: imageBrowserListInput,
    output: imageBrowserListOut,
    tags: [["image"]],
  }),
  detail: query({
    input: z.object({ id: z.string() }),
    output: imageWithEntitySchema.nullable(),
    tags: [["image"]],
  }),
  update: mutation({
    input: imageBrowserUpdateInput,
    output: imageWithEntitySchema,
    invalidates: ripple.image,
  }),
  delete: mutation({
    input: imageBrowserDeleteInput,
    output: imageBrowserDeleteOut,
    invalidates: ripple.image,
  }),
  projectSummaries: query({
    input: projectImageSummariesInput,
    output: projectImageSummariesOut,
    tags: [["image", "projectSummaries"]],
    cache: "stable",
  }),
});

export type ProjectImageSummaries = z.output<typeof projectImageSummariesOut>;
