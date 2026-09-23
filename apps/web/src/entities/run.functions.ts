import { runContract } from "~/contracts/run.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

/** @lintignore Discovered by the operation registry generator. */
export const run = defineOperationDomain(runContract, {
  list: { tags: [["run"]], cache: "browse" },
  detail: { tags: [["run"]] },
  aiUsage: { tags: [["ai", "usage"]] },
});

/** The detail query the generated `runs.$shortcode` route reads and prefetches. */
export const runDetailQuery = (shortcode: string) =>
  run.detail.queryOptions({ shortcode });
