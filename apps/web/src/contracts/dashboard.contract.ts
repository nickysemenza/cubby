import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const dashboardContract = defineContract("dashboard", {
  // The dashboard's local snapshot owns its write revision; a failed snapshot falls back to a strong query without paying a separate freshness RPC.
  counts: query({
    readPolicy: "strong",
    native: "Browse row counts",
    input: z.undefined(),
    output: dashboardCountsOut,
  }),
});
