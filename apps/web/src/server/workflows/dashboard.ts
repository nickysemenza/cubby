import { dashboardCountsOut } from "@cubby/schemas/dashboard";

import type { USDAClient } from "~/server/clients/usda";
import { readDashboardCountsSnapshot } from "~/server/database-freshness/client";
import type { Database } from "~/server/db";
import { getEntityCounts } from "~/server/repo/dashboard";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

type DashboardContext = {
  db: Database;
  usdaClient: Pick<USDAClient, "getCounts">;
};

export const getDashboardCounts = bindWorkflow(
  workflow<DashboardContext, void>("dashboard.counts")
    .parallel("counts", 2, {
      local: async ({ context }) =>
        (await readDashboardCountsSnapshot()) ?? getEntityCounts(context.db),
      usda: ({ context }) =>
        context.usdaClient.getCounts().catch((error) => {
          // USDA is ancillary: local counts remain useful when its worker is unavailable.
          console.warn(
            "[dashboard.counts] USDA count unavailable; using 0",
            error,
          );
          return null;
        }),
    })
    .output(({ counts: { local, usda } }) =>
      dashboardCountsOut.parse({
        ...local,
        usdaFoods: usda?.usda_food ?? 0,
        usdaFoodsAvailable: usda !== null,
      }),
    ),
  (context: DashboardContext) => ({ context, input: undefined }),
);
