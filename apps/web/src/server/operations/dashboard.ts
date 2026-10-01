import { createLogger } from "@cubby/worker-tracing";
import { dashboardCountsOut } from "@cubby/schemas/dashboard";

import { dashboardContract } from "~/contracts/dashboard.contract";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getEntityCounts } from "~/server/repo/dashboard";

const log = createLogger("dashboard.counts");

type DashboardContext = {
  db: Database;
  usdaClient: Pick<USDAClient, "getCounts">;
};

export async function getDashboardCounts({ db, usdaClient }: DashboardContext) {
  const [local, usda] = await Promise.all([
    getEntityCounts(db),
    usdaClient.getCounts().catch((error) => {
      // USDA is ancillary: local counts remain useful when its worker is unavailable.
      log.warn("USDA count unavailable; using 0", { error });
      return null;
    }),
  ]);
  return dashboardCountsOut.parse({
    ...local,
    usdaFoods: usda?.usda_food ?? 0,
    usdaFoodsAvailable: usda !== null,
  });
}

export const dashboardHandlers = implementOperationDomain(dashboardContract, {
  counts: (context) => getDashboardCounts(context),
});
