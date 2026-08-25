import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  financialAccountOptionsOut,
  financialAccountOptionsWorkflow,
  financialTransactionSourceOptionsOut,
  financialTransactionSourceOptionsWorkflow,
} from "~/server/workflows/finance.server";

export const financialAccountOptionsForBrowser = (options: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "financialAccount.options",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: financialAccountOptionsOut,
    request: options.request,
    run: (context) => financialAccountOptionsWorkflow(context.readDb),
  });
export const financialTransactionSourceOptionsForBrowser = (options: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "financialTransaction.sourceOptions",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: financialTransactionSourceOptionsOut,
    request: options.request,
    run: (context) => financialTransactionSourceOptionsWorkflow(context.readDb),
  });
