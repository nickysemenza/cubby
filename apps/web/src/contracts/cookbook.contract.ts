import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const cookbookContract = defineContract("cookbook", {
  list: query({
    native: "Native cookbook browse",
    input: z.null(),
    output: cookbookSummariesOut,
  }),
  detail: query({
    native: "Native cookbook detail",
    input: z.object({ shortcode: cookbookShortcode }),
    output: cookbookSummary.nullable(),
  }),
});
