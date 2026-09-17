import {
  searchContract,
  searchStreamsContract,
} from "~/contracts/search.contract";
import {
  getSearchIndexRepairWorkflow,
  isCloudflareRuntime,
} from "~/server/cf-env";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { streamSearchIndexRepairWorkflow } from "~/server/search-index-repair-workflow-adapter";
import { repairSearchIndex } from "~/server/services/search-index-repair.service";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import { getRequestId } from "~/server/tracing";
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
    repairIndex: async function* (context, _input, signal) {
      const workflow = getSearchIndexRepairWorkflow();
      if (!workflow) {
        if (isCloudflareRuntime()) {
          throw new Error("SEARCH_INDEX_REPAIR Workflow binding is missing");
        }
        yield* repairSearchIndex(context.db, signal);
        return;
      }

      const requestedAt = new Date().toISOString();
      const instance = await workflow.create({
        id: crypto.randomUUID(),
        params: { requestedAt },
        retention: {
          successRetention: "1 day",
          errorRetention: "7 days",
        },
      });
      console.log("[search-index-repair] Workflow started", {
        instanceId: instance.id,
        requestId: getRequestId(context.headers),
      });
      yield* streamSearchIndexRepairWorkflow(instance, signal);
    },
  },
);
