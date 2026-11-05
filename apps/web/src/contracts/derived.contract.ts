import { derivedBacklog } from "@cubby/schemas/derived-backlog";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const derivedContract = defineContract("derived", {
  backlog: query({
    exposure: "view",
    input: z.strictObject({}),
    output: derivedBacklog,
    cache: { profile: "live-status" },
  }),
});
