import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  loadRelatedBranchWorkflow,
  loadRelatedOptionsWorkflow,
  loadRelatedPreviewsWorkflow,
  loadRelatedSummaryWorkflow,
  relatedDataWorkflowSchemas,
} from "~/server/workflows/related-data.server";

const schemas = relatedDataWorkflowSchemas;
const query = <I extends z.ZodType, O>(options: {
  name: string;
  input: I;
  output: z.ZodType<O>;
  data: z.input<I>;
  request: StartOperationRequest;
  run: Parameters<typeof runStartOperation<I, O>>[0]["run"];
}) =>
  runStartOperation({
    operation: options.name,
    type: "query",
    input: options.data,
    inputSchema: options.input,
    outputSchema: options.output,
    request: options.request,
    run: options.run,
  });

export const loadRelatedPreviewsForBrowser = (o: {
  data: z.input<typeof schemas.previews.input>;
  request: StartOperationRequest;
}) =>
  query({
    name: "relatedData.previews",
    input: schemas.previews.input,
    output: schemas.previews.output,
    ...o,
    run: (c, input) => loadRelatedPreviewsWorkflow(c.readDb, input),
  });
export const loadRelatedBranchForBrowser = (o: {
  data: z.input<typeof schemas.branch.input>;
  request: StartOperationRequest;
}) =>
  query({
    name: "relatedData.branch",
    input: schemas.branch.input,
    output: schemas.branch.output,
    ...o,
    run: (c, input) => loadRelatedBranchWorkflow(c.readDb, input),
  });
export const loadRelatedOptionsForBrowser = (o: {
  data: z.input<typeof schemas.options.input>;
  request: StartOperationRequest;
}) =>
  query({
    name: "relatedData.options",
    input: schemas.options.input,
    output: schemas.options.output,
    ...o,
    run: (c, input) => loadRelatedOptionsWorkflow(c.readDb, input),
  });
export const loadRelatedSummaryForBrowser = (o: {
  data: z.input<typeof schemas.summary.input>;
  request: StartOperationRequest;
}) =>
  query({
    name: "relatedData.summary",
    input: schemas.summary.input,
    output: schemas.summary.output,
    ...o,
    run: (c, input) => loadRelatedSummaryWorkflow(c.readDb, input),
  });
