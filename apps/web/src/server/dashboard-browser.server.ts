import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import { getDashboardCounts } from "~/server/workflows/dashboard";

/** Browser adapter: authenticated, strongly consistent, schema-checked read. */
export async function getDashboardCountsForBrowser(options: {
  request: StartOperationRequest;
}) {
  return await runStartOperation({
    operation: "dashboard.counts",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: dashboardCountsOut,
    request: options.request,
    readPolicy: "strong",
    run: async (context) =>
      await getDashboardCounts({
        db: context.db,
        usdaClient: context.usdaClient,
      }),
  });
}
