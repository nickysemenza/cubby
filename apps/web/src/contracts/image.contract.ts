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
    mcp: { omit: "device_protocol", note: "Photos-library sighting sync" },
    native: "Bounded, replay-safe library sighting pages",
    input: imageRecordSightingsInput,
    output: imageRecordSightingsOut,
    invalidates: ["image"],
  }),
  list: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["list"],
      note: "entity_read.list on images",
    },
    native: "Native photo browse",
    input: imageBrowserListInput,
    output: imageBrowserListOut,
    cache: { tags: [["image"]] },
  }),
  analysis: query({
    mcp: { omit: "client_view", note: "Native photo diagnostics" },
    native: "Native photo diagnostics",
    input: z.object({ id: z.string() }),
    output: localPhotoAnalysisSchema.nullable(),
    cache: { tags: [] },
  }),
  recordAnalysis: mutation({
    mcp: { omit: "device_protocol" },
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
    mcp: {
      omit: "kernel_alternative",
      kernel: ["update"],
      note: "entity.update on an image",
    },
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
    mcp: {
      omit: "kernel_alternative",
      kernel: ["delete"],
      note: "entity.delete on images",
    },
    input: imageBrowserDeleteInput,
    output: imageBrowserDeleteOut,
    invalidates: ["image"],
  }),
  projectSummaries: query({
    mcp: { omit: "client_view" },
    input: projectImageSummariesInput,
    output: projectImageSummariesOut,
    cache: { profile: "stable" },
  }),
  hashIndex: query({
    mcp: { omit: "device_protocol", note: "Native deduplication index" },
    native: "Native photo deduplication index",
    input: z.undefined(),
    output: imageHashIndexSchema,
    cache: { tags: [] },
  }),
  setPerceptualHashes: mutation({
    mcp: { omit: "device_protocol" },
    native: "Native legacy photo hash repair",
    input: setPerceptualHashesInputSchema,
    output: setPerceptualHashesOutputSchema,
  }),
});
