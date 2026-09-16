import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const dashboardContract = defineContract("dashboard", {
  counts: query({
    native: "Browse row counts",
    input: z.undefined(),
    output: dashboardCountsOut,
  }),
});
