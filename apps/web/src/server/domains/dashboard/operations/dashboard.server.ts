import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { createLogger } from "@cubby/worker-tracing";

import { dashboardContract } from "~/contracts/dashboard.contract";
import { entityInspectorHealthContract } from "~/contracts/entity-inspector-health.contract";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { getEntityCounts } from "~/server/domains/dashboard/repo/dashboard";
import { countSearchCoverage } from "~/server/generic/search/repo/search-document";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { throwIfOperationAborted } from "~/server/operation-runtime/operation.server";

const log = createLogger("dashboard.counts");

type DashboardContext = {
  db: Database;
  usdaClient: Pick<USDAClient, "getCounts">;
};

export async function getDashboardCounts({ db, usdaClient }: DashboardContext) {
  const [local, usda] = await Promise.all([
    getEntityCounts(db),
    usdaClient.getCounts().catch((error) => {
      // USDA is ancillary: local counts remain useful while a release loads.
      log.warn("USDA count unavailable; using 0", { error });
      return null;
    }),
  ]);
  return dashboardCountsOut.parse({
    ...local,
    usdaFoods: Object.values(usda?.foodsByDataType ?? {}).reduce(
      (total, foods) => total + foods,
      0,
    ),
    usdaFoodsAvailable: usda !== null,
  });
}

export const dashboardHandlers = implementOperationDomain(dashboardContract, {
  counts: (context) => getDashboardCounts(context),
});

export const entityInspectorHealthHandlers = implementOperationDomain(
  entityInspectorHealthContract,
  {
    inspectorHealth: {
      run: async (context) => {
        const [counts, search] = await Promise.all([
          getEntityCounts(context.db),
          countSearchCoverage(context.db),
        ]);
        throwIfOperationAborted(context.signal);
        return { counts, search };
      },
    },
  },
);
