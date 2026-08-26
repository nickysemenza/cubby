import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { type CookbookSummary, cookbookSummary } from "@cubby/schemas/recipe";
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
      refetchOnReconnect: true,
    },
  }),
  detail: query({
    input: z.object({ shortcode: z.string() }),
    output: cookbookSummary.nullable(),
    tags: [["cookbook"]],
  }),
});

export type { CookbookSummary };
