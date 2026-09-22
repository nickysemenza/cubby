import { defineEntityAdapter } from "~/server/entity-kernel/adapter";

import {
  getPurchaseImportRunByShortcode,
  listPurchaseImportRuns,
} from "./purchase-import-run";

/**
 * Read-only: the run service and the import writer own every write. The
 * manifest declares `delete: null`, so the kernel's capability gate refuses a
 * delete before this adapter is reached; the port below exists only because
 * the repository contract is not conditional on it.
 */
export const purchaseImportRunEntityAdapter = defineEntityAdapter({
  entity: "purchaseImportRun",
  lifecycle: { delete: {} },
  repository: {
    get: (ctx, id) => getPurchaseImportRunByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listPurchaseImportRuns(ctx.db, filters, sorts, pagination),
    delete: () => {
      throw new Error(
        "Import runs are immutable history and cannot be deleted",
      );
    },
  },
});
