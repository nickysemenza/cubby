import {
  type DashboardCountsOut,
  dashboardCountsOut,
} from "@cubby/schemas/dashboard";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { getEntityCounts } from "~/server/repo/dashboard";

type DashboardCountsReader = Pick<USDAClient, "getCounts">;

/**
 * Shared dashboard workflow for browser Start and in-process callers.
 * USDA is ancillary: local counts remain useful when the bound worker is
 * unavailable.
 */
export async function getDashboardCounts(options: {
  db: Database;
  usdaClient: DashboardCountsReader;
}): Promise<DashboardCountsOut> {
  const [entityCounts, usdaCounts] = await Promise.all([
    getEntityCounts(options.db),
    options.usdaClient.getCounts().catch((error) => {
      console.warn("[dashboard.counts] USDA count unavailable; using 0", error);
      return null;
    }),
  ]);
  return dashboardCountsOut.parse({
    ...entityCounts,
    usdaFoods: usdaCounts?.usda_food ?? 0,
  });
}
