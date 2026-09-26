import { photoImportContract } from "~/contracts/photo-import.contract";
import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import { runContract } from "~/contracts/run.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

// Every run read carries the `run` tag, so one `ripple.runOnly` after a run
// write refreshes the record, its work view, log, history and photo review.
const RUN_TAGS = { tags: [["run"]] } as const;
const RUN_WRITE = { invalidates: ripple.runOnly } as const;

/** @lintignore Discovered by the operation registry generator. */
export const run = defineOperationDomain(runContract, {
  list: { ...RUN_TAGS, cache: "browse" },
  detail: RUN_TAGS,
  work: RUN_TAGS,
  logs: RUN_TAGS,
  history: RUN_TAGS,
  control: RUN_WRITE,
  startTargeted: RUN_WRITE,
  agentConnection: RUN_TAGS,
  disconnectAgent: RUN_WRITE,
  aiUsage: { tags: [["ai", "usage"]] },
});

/** @lintignore Discovered by the operation registry generator. */
export const photoImport = defineOperationDomain(photoImportContract, {
  review: RUN_TAGS,
  candidates: { tags: [["photoImport", "candidates"]] },
  startGrouping: RUN_WRITE,
  saveGroups: RUN_WRITE,
  approveGroups: RUN_WRITE,
  discardGroup: RUN_WRITE,
});

/** @lintignore Discovered by the operation registry generator. */
export const purchaseImport = defineOperationDomain(purchaseImportContract);

/** The detail query the generated `runs.$shortcode` route reads and prefetches. */
export const runDetailQuery = (shortcode: string) =>
  run.detail.queryOptions({ shortcode });
