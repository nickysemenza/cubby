import { maintenanceContract } from "~/contracts/maintenance.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  backfillImageProcessing,
  imageProcessingMaintenanceSummary,
  updateImageProcessingSettings,
} from "~/server/repo/image-processing-maintenance";
import { requestCatchUp } from "~/server/services/app-open-catch-up.service";
import {
  countAwaitingWork,
  settleAwaitingWork,
} from "~/server/services/awaiting-work.service";
import { repairImageDimensions } from "~/server/services/image-dimension-repair.service";
import { backfillImageMetadata } from "~/server/services/image-metadata-backfill.service";
import { classifyImageProvenance } from "~/server/services/image-provenance-classify.service";
import { backfillImageSearchDocuments } from "~/server/services/image-search-backfill.service";

/** Counts read the authoritative handle: this is the truth the badge and the cron agree on. */
export const maintenanceHandlers = implementOperationDomain(
  maintenanceContract,
  {
    requestCatchUp: (context) => requestCatchUp(context.db),
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
    backfillImageMetadata: (context, input) =>
      backfillImageMetadata(context.db, input),
    backfillImageSearch: (context, input) =>
      backfillImageSearchDocuments(context.db, input),
  },
);
