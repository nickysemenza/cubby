import {
  searchContract,
  searchStreamsContract,
} from "~/contracts/search.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { repairSearchIndex } from "~/server/services/search-index-repair.service";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  findGroupedSearchHitsWorkflow,
  findRelatedSearchGroupsWorkflow,
  findRelatedSearchHitsWorkflow,
  findSearchHitsWorkflow,
  inspectSearchDebugWorkflow,
  requestEmbeddingRefreshWorkflow,
} from "~/server/workflows/search.server";

/**
 * User-facing search reads ride the cached read handle; debug and the
 * embedding refresh stay authoritative through the central browser read policy.
 */
export const searchHandlers = implementOperationDomain(searchContract, {
  find: (context, input) => findSearchHitsWorkflow(context.readDb, input),
  grouped: (context, input) =>
    findGroupedSearchHitsWorkflow(context.readDb, input),
  related: (context, input) =>
    findRelatedSearchHitsWorkflow(context.readDb, input),
  relatedGrouped: (context, input) =>
    findRelatedSearchGroupsWorkflow(context.readDb, input),
  debug: (context, input) => inspectSearchDebugWorkflow(context.db, input),
  requestEmbeddingRefresh: (context, input) =>
    requestEmbeddingRefreshWorkflow(context.db, input),
});

export const searchStreamHandlers = implementSubscriptionDomain(
  searchStreamsContract,
  {
    repairIndex: (context, _input, signal) =>
      repairSearchIndex(context.db, signal),
  },
);
