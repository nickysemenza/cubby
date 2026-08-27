import { search } from "~/lib/search.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  enqueueEmbeddingBackfillWorkflow,
  findRelatedSearchHitsWorkflow,
  findSearchHitsWorkflow,
  inspectSearchDebugWorkflow,
  inspectSearchDocumentHealthWorkflow,
  repairSearchDocumentsWorkflow,
  requestEmbeddingRefreshWorkflow,
} from "~/server/workflows/search.server";

/**
 * User-facing search reads ride the cached read handle; document health,
 * repair, debug, and the embedding mutations stay authoritative — asserted by
 * read-policy.unit.test.ts.
 */
export const searchHandlers = implementOperationDomain(search, {
  find: (context, input) => findSearchHitsWorkflow(context.readDb, input),
  documentHealth: {
    readPolicy: "strong",
    run: (context) => inspectSearchDocumentHealthWorkflow(context.db),
  },
  repairDocuments: (context) => repairSearchDocumentsWorkflow(context.db),
  related: (context, input) =>
    findRelatedSearchHitsWorkflow(context.readDb, input),
  debug: (context, input) => inspectSearchDebugWorkflow(context.db, input),
  enqueueEmbeddingBackfill: (context, input) =>
    enqueueEmbeddingBackfillWorkflow(context.db, input),
  requestEmbeddingRefresh: (context, input) =>
    requestEmbeddingRefreshWorkflow(context.db, input),
});
