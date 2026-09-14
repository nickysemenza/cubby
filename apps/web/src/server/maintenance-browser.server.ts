import { maintenanceContract } from "~/contracts/maintenance.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  countAwaitingWork,
  settleAwaitingWork,
} from "~/server/services/awaiting-work.service";
import { repairImageDimensions } from "~/server/services/image-dimension-repair.service";

/** Counts read the authoritative handle: this is the truth the badge and the cron agree on. */
export const maintenanceHandlers = implementOperationDomain(
  maintenanceContract,
  {
    awaitingWork: (context) => countAwaitingWork(context.db),
    settleAwaitingWork: (context) => settleAwaitingWork(context.db),
    repairImageDimensions: (context, input) =>
      repairImageDimensions(context.db, input),
  },
);
