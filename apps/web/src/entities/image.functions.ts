import { projectImageSummariesOut } from "@cubby/schemas/image";
import { z } from "zod";

import { imageContract } from "~/contracts/image.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const image = defineOperationDomain(imageContract, {
  list: {
    tags: [["image"]],
  },
  detail: {
    tags: [["image"]],
  },
  update: {
    invalidates: ripple.image,
  },
  delete: {
    invalidates: ripple.image,
  },
  attachExisting: {
    invalidates: ripple.image,
  },
  projectSummaries: {
    tags: [["image", "projectSummaries"]],
    cache: "stable",
  },
});

/** The detail query the generated `images.$shortcode` route reads and prefetches. */
export const imageDetailQuery = (shortcode: string) =>
  image.detail.queryOptions({ id: shortcode });

export type ProjectImageSummaries = z.output<typeof projectImageSummariesOut>;
