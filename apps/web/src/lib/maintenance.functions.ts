import { maintenanceContract } from "~/contracts/maintenance.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const maintenance = defineOperationDomain(maintenanceContract, {
  backfillImageProcessing: { invalidates: ripple.maintenance },
  imageProcessing: { tags: [["maintenance"], ["image"]] },
  configureImageProcessing: { invalidates: ripple.maintenance },
  awaitingWork: { tags: [["maintenance", "awaitingWork"]] },
  settleAwaitingWork: { invalidates: ripple.maintenance },
  repairImageDimensions: { invalidates: ripple.maintenance },
  classifyImageProvenance: { invalidates: ripple.image },
  backfillImageMetadata: { invalidates: ripple.image },
});
