import type { projectImageSummariesOut } from "@cubby/schemas/image";
import type { z } from "zod";

import { image } from "~/integrations/tanstack-query/generated/catalog.gen";

/** The detail query the generated `images.$shortcode` route reads and prefetches. */
export const imageDetailQuery = (shortcode: string) =>
  image.detail.queryOptions({ id: shortcode });

export type ProjectImageSummaries = z.output<typeof projectImageSummariesOut>;
