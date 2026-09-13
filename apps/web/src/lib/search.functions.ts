import {
  searchContract,
  searchStreamsContract,
} from "~/contracts/search.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const search = defineOperationDomain(searchContract, {
  find: { tags: [["search", "find"]] },
  grouped: { tags: [["search", "grouped"]] },
  related: { tags: [["search", "related"]] },
  relatedGrouped: { tags: [["search", "relatedGrouped"]] },
  debug: { tags: [["search", "debug"]] },
  // The refresh is accepted, not done; the relatedness readiness poll (not an
  // invalidation) is what observes it landing.
  requestEmbeddingRefresh: { invalidates: ripple.none },
});

export const searchStreams = defineOperationDomain(searchStreamsContract);

export const openSearchIndexRepairStream = (signal?: AbortSignal) =>
  searchStreams.repairIndex.open(undefined, { signal });
