import { maintenanceContract } from "~/contracts/maintenance.contract";
import { repairImageDimensions } from "~/server/domains/image/service/image-dimension-repair.service";
import { classifyImageProvenance } from "~/server/domains/image/service/image-provenance-classify.service";
import { backfillImageSearchDocuments } from "~/server/domains/image/service/image-search-backfill.service";
import {
  launchMaintenanceRun,
  readMaintenanceStatus,
} from "~/server/domains/maintenance/service/maintenance.service";
import { readDerivedRebuildStatus } from "~/server/generic/derived/repo/rebuild";
import { requestDerivedRebuild } from "~/server/generic/derived/repo/rebuild";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { wakeAt } from "~/server/workflows/background-tasks/publish";
import { requestCatchUp } from "~/server/workflows/catch-up";

export const maintenanceHandlers = implementOperationDomain(
  maintenanceContract,
  {
    requestCatchUp: (context) => requestCatchUp(context.db),
    run: (context) =>
      launchMaintenanceRun(context.db, context.actorContext, "manual"),
    status: (context) => readMaintenanceStatus(context.db),
    derivedRebuildStatus: (context) => readDerivedRebuildStatus(context.db),
    rebuildDerived: async (context) => {
      const receipt = await requestDerivedRebuild(context.db);
      await wakeAt(new Date(), { source: "manual-derived-rebuild" });
      return receipt;
    },
    repairImageDimensions: (context, input) =>
      repairImageDimensions(context.db, input),
    classifyImageProvenance: (context, input) =>
      classifyImageProvenance(context.db, input, context.actorContext),
    backfillImageSearch: (context, input) =>
      backfillImageSearchDocuments(context.db, input),
  },
);
