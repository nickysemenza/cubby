import { maintenanceContract } from "~/contracts/maintenance.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const maintenance = defineOperationDomain(maintenanceContract, {
  awaitingWork: { tags: [["maintenance", "awaitingWork"]] },
  settleAwaitingWork: { invalidates: ripple.maintenance },
});
