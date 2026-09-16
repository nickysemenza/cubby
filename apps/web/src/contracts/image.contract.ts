import {
  imageBrowserDeleteInput,
  imageBrowserDeleteOut,
  imageBrowserListInput,
  imageBrowserListOut,
  imageBrowserUpdateInput,
  imageWithEntitySchema,
  imageHashIndexSchema,
  setPerceptualHashesInputSchema,
  setPerceptualHashesOutputSchema,
  projectImageSummariesInput,
  projectImageSummariesOut,
} from "@cubby/schemas/image";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const imageContract = defineContract("image", {
  list: query({
    input: imageBrowserListInput,
    output: imageBrowserListOut,
  }),
  detail: query({
    native: "Native photo detail",
    input: z.object({ id: z.string() }),
    output: imageWithEntitySchema.nullable(),
  }),
  update: mutation({
    input: imageBrowserUpdateInput,
    output: imageWithEntitySchema,
  }),
  delete: mutation({
    input: imageBrowserDeleteInput,
    output: imageBrowserDeleteOut,
  }),
  projectSummaries: query({
    input: projectImageSummariesInput,
    output: projectImageSummariesOut,
  }),
  hashIndex: query({
    native: "Native photo deduplication index",
    input: z.undefined(),
    output: imageHashIndexSchema,
  }),
  setPerceptualHashes: mutation({
    native: "Native legacy photo hash repair",
    input: setPerceptualHashesInputSchema,
    output: setPerceptualHashesOutputSchema,
  }),
});
