import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { cookbookUpdateInput } from "@cubby/schemas/recipe";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const cookbookContract = defineContract(
  "cookbook",
  {
    // The full roster for the recipe cookbook pickers; browsing pages the
    // kernel list (`resources.cookbook.list`).
    list: query({
      description:
        "Cookbooks (recipe sources) with the number of recipes from each.",
      input: z.null(),
      output: cookbookSummariesOut,
      cache: { tags: [["cookbook"]], profile: "browse" },
    }),
    // A retitle also moves every recipe's source label.
    update: mutation({
      exposure: "view",
      note: "entity.update on a cookbook",
      input: z.object({ id: cookbookShortcode, data: cookbookUpdateInput }),
      output: z.object({ id: cookbookShortcode }),
      invalidates: ["recipeCookbook"],
    }),
  },
  { exposure: "capability", mcpToolGroup: "recipe_insights" },
);
