import { defineEntityAdapter } from "~/server/entity-kernel/adapter";

import { getImportRunByShortcode, listImportRuns } from "./import-run";

/**
 * Read-only: the run service and the import writer own every write. The
 * manifest declares `delete: null`, so the kernel's capability gate refuses a
 * delete before this adapter is reached; the port below exists only because
 * the repository contract is not conditional on it.
 */
export const importRunEntityAdapter = defineEntityAdapter({
  entity: "importRun",
  lifecycle: { delete: {} },
  repository: {
    get: (ctx, id) => getImportRunByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listImportRuns(ctx.db, filters, sorts, pagination),
    delete: () => {
      throw new Error(
        "Import runs are immutable history and cannot be deleted",
      );
    },
  },
});
