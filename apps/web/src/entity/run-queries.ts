import { run } from "~/integrations/tanstack-query/generated/catalog.gen";

/** The detail query the generated `runs.$shortcode` route reads and prefetches. */
export const runDetailQuery = (shortcode: string) =>
  run.detail.queryOptions({ shortcode });
