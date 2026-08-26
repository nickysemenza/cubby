import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { z } from "zod";
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const dashboard = defineOperationDomain("dashboard", {
  counts: query({
    input: z.undefined(),
    output: dashboardCountsOut,
    tags: [["dashboard", "counts"]],
  }),
});
