import { dashboard } from "~/lib/dashboard.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getDashboardCounts } from "~/server/workflows/dashboard";

/** Browser adapter: authenticated, strongly consistent, schema-checked read. */
export const dashboardHandlers = implementOperationDomain(dashboard, {
  counts: {
    readPolicy: "strong",
    run: (context) =>
      getDashboardCounts({ db: context.db, usdaClient: context.usdaClient }),
  },
});
