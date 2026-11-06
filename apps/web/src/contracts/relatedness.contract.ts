import { relatednessOutSchema } from "@cubby/schemas/relatedness";
import {
  embeddableEntitySchema,
  searchableEntityIdSchema,
} from "@cubby/schemas/search";
import { z } from "zod";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, query } from "~/contracts/define";

const relatednessInputSchema = z.object({
  entity: embeddableEntitySchema,
  id: searchableEntityIdSchema,
});
export type RelatednessInput = z.infer<typeof relatednessInputSchema>;

export const relatednessContract = defineContract(
  "relatedness",
  {
    forEntity: query({
      exposure: "view",
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
      input: relatednessInputSchema,
      output: relatednessOutSchema,
    }),
  },
  { exposure: "internal" },
);
