import {
  imageBrowserDeleteInput,
  imageBrowserDeleteOut,
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

export const imageContract = defineContract(
  "image",
  {
    recordSightings: mutation({
      exposure: "view",
      note: "Photos-library sighting sync",
      input: imageRecordSightingsInput,
      output: imageRecordSightingsOut,
      invalidates: ["image"],
    }),
    analysis: query({
      note: "Native photo diagnostics",
      input: z.object({ id: z.string() }),
      output: localPhotoAnalysisSchema.nullable(),
      cache: { tags: [] },
    }),
    recordAnalysis: mutation({
      exposure: "view",
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
      note: "entity.update on an image",
      input: imageBrowserUpdateInput,
      output: imageWithEntitySchema,
      invalidates: ["image"],
    }),
    attachExisting: mutation({
      exposure: "capability",
      description:
        "Attach an existing uploaded image without re-uploading it. Galleries append and restore detached links; specify role cover for a Cookbook or logo for a Vendor to replace the current singular image. Repeating the current attachment is idempotent.",
      input: imageAttachExistingInput,
      output: imageAttachExistingOutput,
      invalidates: ["image"],
    }),
    delete: mutation({
      note: "entity.delete on images",
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
      exposure: "view",
      note: "Native deduplication index",
      input: z.undefined(),
      output: imageHashIndexSchema,
      cache: { tags: [] },
    }),
    setPerceptualHashes: mutation({
      exposure: "view",
      input: setPerceptualHashesInputSchema,
      output: setPerceptualHashesOutputSchema,
    }),
  },
  { exposure: "view" },
);
