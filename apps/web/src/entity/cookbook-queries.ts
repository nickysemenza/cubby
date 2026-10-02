import { cookbook } from "~/integrations/tanstack-query/generated/catalog.gen";

/** The detail query the generated `cookbooks.$shortcode` route reads and prefetches. */
export const cookbookDetailQuery = (shortcode: string) =>
  cookbook.detail.queryOptions({ shortcode });
