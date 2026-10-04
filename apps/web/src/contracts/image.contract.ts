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
  imageAttachExistingInput,
  imageAttachExistingOutput,
} from "@cubby/schemas/image";
import {
  imageRecordSightingsInput,
  imageRecordSightingsOut,
} from "@cubby/schemas/image-sighting";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";
import {
  buildLocalPhotoAnalysisSchema,
  localPhotoAnalysisSchema,
} from "~/contracts/photo-import.contract";

export const imageContract = defineContract("image", {
  recordSightings: mutation({
    native: "Bounded, replay-safe library sighting pages",
    input: imageRecordSightingsInput,
    output: imageRecordSightingsOut,
    invalidates: ["image"],
  }),
  list: query({
    native: "Native photo browse",
    input: imageBrowserListInput,
    output: imageBrowserListOut,
    cache: { tags: [["image"]] },
  }),
  detail: query({
    native: "Native photo detail",
    input: z.object({ id: z.string() }),
    output: imageWithEntitySchema.nullable(),
    cache: { tags: [["image"]] },
  }),
  analysis: query({
    native: "Native photo diagnostics",
    input: z.object({ id: z.string() }),
    output: localPhotoAnalysisSchema.nullable(),
    cache: { tags: [] },
  }),
  recordAnalysis: mutation({
    native: "Native photo diagnostics backfill",
    // A fresh instance (not `localPhotoAnalysisSchema`): see the builder's
    // doc comment in photo-import.contract.ts — reusing the same object here
    // would collapse the commit contract's inlined per-image analysis field
    // into a shared, positionally-named component.
    input: z.object({
      id: z.string(),
      analysis: buildLocalPhotoAnalysisSchema(),
    }),
    output: z.object({ saved: z.boolean() }),
  }),
  update: mutation({
    input: imageBrowserUpdateInput,
    output: imageWithEntitySchema,
    invalidates: ["image"],
  }),
  attachExisting: mutation({
    native: "Attach an existing image to a record from its Used by section",
    input: imageAttachExistingInput,
    output: imageAttachExistingOutput,
    invalidates: ["image"],
  }),
  delete: mutation({
    input: imageBrowserDeleteInput,
    output: imageBrowserDeleteOut,
    invalidates: ["image"],
  }),
  projectSummaries: query({
    input: projectImageSummariesInput,
    output: projectImageSummariesOut,
    cache: { profile: "stable" },
  }),
  hashIndex: query({
    native: "Native photo deduplication index",
    input: z.undefined(),
    output: imageHashIndexSchema,
    cache: { tags: [] },
  }),
  setPerceptualHashes: mutation({
    native: "Native legacy photo hash repair",
    input: setPerceptualHashesInputSchema,
    output: setPerceptualHashesOutputSchema,
  }),
});
