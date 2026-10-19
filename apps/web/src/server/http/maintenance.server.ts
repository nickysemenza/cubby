import { maintenanceContract } from "~/contracts/maintenance.contract";
import { repairImageDimensions } from "~/server/domains/image/service/image-dimension-repair.service";
import { classifyImageProvenance } from "~/server/domains/image/service/image-provenance-classify.service";
import { backfillImageSearchDocuments } from "~/server/domains/image/service/image-search-backfill.service";
import {
  launchMaintenanceRun,
  readMaintenanceStatus,
} from "~/server/domains/maintenance/service/maintenance.service";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { requestCatchUp } from "~/server/workflows/catch-up";

export const maintenanceHandlers = implementOperationDomain(
  maintenanceContract,
  {
    requestCatchUp: (context) => requestCatchUp(context.db),
    run: (context) =>
      launchMaintenanceRun(context.db, context.actorContext, "manual"),
    status: (context) => readMaintenanceStatus(context.db),
    repairImageDimensions: (context, input) =>
      repairImageDimensions(context.db, input),
    classifyImageProvenance: (context, input) =>
      classifyImageProvenance(context.db, input, context.actorContext),
    backfillImageSearch: (context, input) =>
      backfillImageSearchDocuments(context.db, input),
  },
);
