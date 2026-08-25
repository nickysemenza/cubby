import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  lookupUpcWorkflow,
  upcWorkflowSchemas,
} from "~/server/workflows/upc.server";

export const lookupUpcForBrowser = (options: {
  data: z.input<typeof upcWorkflowSchemas.lookup.input>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "upc.lookup",
    type: "query",
    input: options.data,
    inputSchema: upcWorkflowSchemas.lookup.input,
    outputSchema: upcWorkflowSchemas.lookup.output,
    request: options.request,
    run: lookupUpcWorkflow,
  });
