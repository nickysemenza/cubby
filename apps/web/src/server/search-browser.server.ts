import { searchContract } from "~/contracts/search.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  enqueueEmbeddingBackfillWorkflow,
  findGroupedSearchHitsWorkflow,
  findRelatedSearchGroupsWorkflow,
  findRelatedSearchHitsWorkflow,
  findSearchHitsWorkflow,
  inspectSearchDebugWorkflow,
  inspectSearchDocumentHealthWorkflow,
  repairSearchDocumentsWorkflow,
  requestEmbeddingRefreshWorkflow,
} from "~/server/workflows/search.server";

/**
 * User-facing search reads ride the cached read handle; document health,
 * repair, debug, and the embedding mutations stay authoritative through the
 * central browser read policy.
 */
export const searchHandlers = implementOperationDomain(searchContract, {
  find: (context, input) => findSearchHitsWorkflow(context.readDb, input),
  grouped: (context, input) =>
    findGroupedSearchHitsWorkflow(context.readDb, input),
  documentHealth: {
    run: (context) => inspectSearchDocumentHealthWorkflow(context.db),
  },
  repairDocuments: (context) => repairSearchDocumentsWorkflow(context.db),
  related: (context, input) =>
    findRelatedSearchHitsWorkflow(context.readDb, input),
  relatedGrouped: (context, input) =>
    findRelatedSearchGroupsWorkflow(context.readDb, input),
  debug: (context, input) => inspectSearchDebugWorkflow(context.db, input),
  enqueueEmbeddingBackfill: (context, input) =>
    enqueueEmbeddingBackfillWorkflow(context.db, input),
  requestEmbeddingRefresh: (context, input) =>
    requestEmbeddingRefreshWorkflow(context.db, input),
});
