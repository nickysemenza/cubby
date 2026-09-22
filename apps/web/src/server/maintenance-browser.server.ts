import { maintenanceContract } from "~/contracts/maintenance.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  backfillImageProcessing,
  imageProcessingMaintenanceSummary,
  updateImageProcessingSettings,
} from "~/server/repo/image-processing-maintenance";
import {
  countAwaitingWork,
  settleAwaitingWork,
} from "~/server/services/awaiting-work.service";
import { repairImageDimensions } from "~/server/services/image-dimension-repair.service";
import { classifyImageProvenance } from "~/server/services/image-provenance-classify.service";

/** Counts read the authoritative handle: this is the truth the badge and the cron agree on. */
export const maintenanceHandlers = implementOperationDomain(
  maintenanceContract,
  {
    backfillImageProcessing: (context, input) =>
      backfillImageProcessing(context.db, input),
    imageProcessing: (context) => imageProcessingMaintenanceSummary(context.db),
    configureImageProcessing: (context, input) =>
      updateImageProcessingSettings(context.db, input),
    awaitingWork: (context) => countAwaitingWork(context.db),
    settleAwaitingWork: (context) => settleAwaitingWork(context.db),
    repairImageDimensions: (context, input) =>
      repairImageDimensions(context.db, input),
    classifyImageProvenance: (context, input) =>
      classifyImageProvenance(context.db, input),
  },
);
