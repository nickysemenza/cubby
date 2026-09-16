import { cookbookContract } from "~/contracts/cookbook.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const cookbook = defineOperationDomain(cookbookContract, {
  list: {
    tags: [["cookbook"]],
    cache: "browse",
  },
  detail: {
    tags: [["cookbook"]],
  },
});

/** The detail query the generated `cookbooks.$shortcode` route reads and prefetches. */
export const cookbookDetailQuery = (shortcode: string) =>
  cookbook.detail.queryOptions({ shortcode });
