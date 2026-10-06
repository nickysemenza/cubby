import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { cookbookSummary, cookbookUpdateInput } from "@cubby/schemas/recipe";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const cookbookContract = defineContract("cookbook", {
  list: query({
    native: "Native cookbook browse",
    input: z.null(),
    output: cookbookSummariesOut,
    cache: { tags: [["cookbook"]], profile: "browse" },
  }),
  // A retitle also moves every recipe's source label.
  update: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["update"],
      note: "entity.update on a cookbook",
    },
    input: z.object({ id: cookbookShortcode, data: cookbookUpdateInput }),
    output: cookbookSummary,
    invalidates: ["recipeCookbook"],
  }),
});
