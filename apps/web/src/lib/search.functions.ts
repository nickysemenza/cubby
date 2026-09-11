import { searchContract } from "~/contracts/search.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const search = defineOperationDomain(searchContract, {
  find: { tags: [["search", "find"]] },
  grouped: { tags: [["search", "grouped"]] },
  documentHealth: { tags: [["search", "documentHealth"]] },
  repairDocuments: { invalidates: ripple.search },
  related: { tags: [["search", "related"]] },
  relatedGrouped: { tags: [["search", "relatedGrouped"]] },
  debug: { tags: [["search", "debug"]] },
  enqueueEmbeddingBackfill: {
    // `["problems"]` too: the Problems page's "missing embeddings" card is the
    // one surface that starts this, and it used to get that invalidation from
    // the per-card hook rather than from the operation.
    invalidates: ripple.searchBackgroundBatchProblems,
  },
  requestEmbeddingRefresh: { invalidates: ripple.searchBackgroundBatch },
});
