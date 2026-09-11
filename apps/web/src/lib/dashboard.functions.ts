import { dashboardContract } from "~/contracts/dashboard.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const dashboard = defineOperationDomain(dashboardContract, {
  counts: { tags: [["dashboard", "counts"]] },
});
