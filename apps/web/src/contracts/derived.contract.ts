import { derivedBacklog } from "@cubby/schemas/derived-backlog";
import { entitySchema } from "@cubby/schemas/entity";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const derivedContract = defineContract("derived", {
  backlog: query({
    exposure: "view",
    input: z.strictObject({}),
    output: derivedBacklog,
    cache: {
      tags: entitySchema.options.map((entity) => [entity] as const),
      profile: "live-status",
    },
  }),
});
