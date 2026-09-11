import { dashboardContract } from "~/contracts/dashboard.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getDashboardCounts } from "~/server/workflows/dashboard";

/** Browser adapter: authenticated, policy-selected, schema-checked read. */
export const dashboardHandlers = implementOperationDomain(dashboardContract, {
  counts: {
    run: (context) =>
      getDashboardCounts({ db: context.db, usdaClient: context.usdaClient }),
  },
});
