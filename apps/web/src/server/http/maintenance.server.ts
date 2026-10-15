import { maintenanceContract } from "~/contracts/maintenance.contract";
import {
  backfillImageProcessing,
  imageProcessingMaintenanceSummary,
  updateImageProcessingSettings,
} from "~/server/domains/image-processing/repo/image-processing-maintenance";
import { repairImageDimensions } from "~/server/domains/image/service/image-dimension-repair.service";
import { backfillImageMetadata } from "~/server/domains/image/service/image-metadata-backfill.service";
import { classifyImageProvenance } from "~/server/domains/image/service/image-provenance-classify.service";
import { backfillImageSearchDocuments } from "~/server/domains/image/service/image-search-backfill.service";
import {
  countAwaitingWork,
  settleAwaitingWork,
} from "~/server/generic/work-queue/service/awaiting-work.service";
import { requestCatchUp } from "~/server/generic/work-queue/service/catch-up.service";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

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
      classifyImageProvenance(context.db, input, context.actorContext),
    backfillImageMetadata: (context, input) =>
      backfillImageMetadata(context.db, input),
    backfillImageSearch: (context, input) =>
      backfillImageSearchDocuments(context.db, input),
  },
);
