import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { z } from "zod";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const cookbook = defineOperationDomain("cookbook", {
  list: query({
    input: z.null(),
    output: cookbookSummariesOut,
    tags: [["cookbook"]],
    freshness: {
      staleTime: 2 * 60_000,
      refetchOnWindowFocus: true,
    },
  }),
  detail: query({
    input: z.object({ shortcode: cookbookShortcode }),
    output: cookbookSummary.nullable(),
    tags: [["cookbook"]],
  }),
});
