import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  enqueueEmbeddingBackfillWorkflow,
  findRelatedSearchHitsWorkflow,
  findSearchHitsWorkflow,
  inspectSearchDebugWorkflow,
  inspectSearchDocumentHealthWorkflow,
  repairSearchDocumentsWorkflow,
  requestEmbeddingRefreshWorkflow,
  searchWorkflowSchemas,
} from "~/server/workflows/search.server";

export const findSearchHitsForBrowser = (o: {
  data: z.input<typeof searchWorkflowSchemas.find.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "search.find",
    type: "query",
    input: o.data,
    inputSchema: searchWorkflowSchemas.find.input,
    outputSchema: searchWorkflowSchemas.find.output,
    request: o.request,
    run: (context, input) => findSearchHitsWorkflow(context.readDb, input),
  });
export const inspectSearchDocumentHealthForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "search.documentHealth",
    type: "query",
    input: undefined,
    inputSchema: searchWorkflowSchemas.documentHealth.input,
    outputSchema: searchWorkflowSchemas.documentHealth.output,
    request: o.request,
    readPolicy: "strong",
    run: (context) => inspectSearchDocumentHealthWorkflow(context.db),
  });
export const repairSearchDocumentsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "search.repairDocuments",
    type: "mutation",
    input: undefined,
    inputSchema: searchWorkflowSchemas.repairDocuments.input,
    outputSchema: searchWorkflowSchemas.repairDocuments.output,
    request: o.request,
    run: (context) => repairSearchDocumentsWorkflow(context.db),
  });
export const findRelatedSearchHitsForBrowser = (o: {
  data: z.input<typeof searchWorkflowSchemas.related.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "search.related",
    type: "query",
    input: o.data,
    inputSchema: searchWorkflowSchemas.related.input,
    outputSchema: searchWorkflowSchemas.related.output,
    request: o.request,
    run: (context, input) =>
      findRelatedSearchHitsWorkflow(context.readDb, input),
  });
export const inspectSearchDebugForBrowser = (o: {
  data: z.input<typeof searchWorkflowSchemas.debug.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "search.debug",
    type: "query",
    input: o.data,
    inputSchema: searchWorkflowSchemas.debug.input,
    outputSchema: searchWorkflowSchemas.debug.output,
    request: o.request,
    run: (context, input) => inspectSearchDebugWorkflow(context.db, input),
  });
export const enqueueEmbeddingBackfillForBrowser = (o: {
  data: z.input<typeof searchWorkflowSchemas.enqueueEmbeddingBackfill.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "search.enqueueEmbeddingBackfill",
    type: "mutation",
    input: o.data,
    inputSchema: searchWorkflowSchemas.enqueueEmbeddingBackfill.input,
    outputSchema: searchWorkflowSchemas.enqueueEmbeddingBackfill.output,
    request: o.request,
    run: (context, input) =>
      enqueueEmbeddingBackfillWorkflow(context.db, input),
  });
export const requestEmbeddingRefreshForBrowser = (o: {
  data: z.input<typeof searchWorkflowSchemas.requestEmbeddingRefresh.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "search.requestEmbeddingRefresh",
    type: "mutation",
    input: o.data,
    inputSchema: searchWorkflowSchemas.requestEmbeddingRefresh.input,
    outputSchema: searchWorkflowSchemas.requestEmbeddingRefresh.output,
    request: o.request,
    run: (context, input) => requestEmbeddingRefreshWorkflow(context.db, input),
  });
