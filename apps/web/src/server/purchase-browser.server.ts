import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  attachPurchaseProductsWorkflow,
  detachPurchaseProductsWorkflow,
  linkExpensesToPurchaseInput,
  linkExpensesToPurchaseWorkflow,
  mergePurchasesInput,
  mergePurchasesOut,
  mergePurchasesWorkflow,
  purchaseOut,
  purchaseProductMutationInput,
  purchaseProductMutationOut,
  purchaseProductsInput,
  purchaseProductsOut,
  purchaseProductsWorkflow,
  splitExpenseInput,
  splitExpenseOut,
  splitExpenseWorkflow,
} from "~/server/workflows/purchase.server";

export const purchaseProductsForBrowser = (options: {
  data: z.input<typeof purchaseProductsInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "purchase.products",
    type: "query",
    input: options.data,
    inputSchema: purchaseProductsInput,
    outputSchema: purchaseProductsOut,
    request: options.request,
    run: (context, input) => purchaseProductsWorkflow(context, input),
  });
export const linkPurchaseForBrowser = (options: {
  data: z.input<typeof linkExpensesToPurchaseInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "purchase.link",
    type: "mutation",
    input: options.data,
    inputSchema: linkExpensesToPurchaseInput,
    outputSchema: purchaseOut,
    request: options.request,
    run: (context, input) => linkExpensesToPurchaseWorkflow(context, input),
  });
export const splitPurchaseForBrowser = (options: {
  data: z.input<typeof splitExpenseInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "purchase.split",
    type: "mutation",
    input: options.data,
    inputSchema: splitExpenseInput,
    outputSchema: splitExpenseOut,
    request: options.request,
    run: (context, input) => splitExpenseWorkflow(context, input),
  });
export const mergePurchaseForBrowser = (options: {
  data: z.input<typeof mergePurchasesInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "purchase.merge",
    type: "mutation",
    input: options.data,
    inputSchema: mergePurchasesInput,
    outputSchema: mergePurchasesOut,
    request: options.request,
    run: (context, input) => mergePurchasesWorkflow(context, input),
  });
export const attachPurchaseProductsForBrowser = (options: {
  data: z.input<typeof purchaseProductMutationInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "purchase.attachProducts",
    type: "mutation",
    input: options.data,
    inputSchema: purchaseProductMutationInput,
    outputSchema: purchaseProductMutationOut,
    request: options.request,
    run: (context, input) => attachPurchaseProductsWorkflow(context, input),
  });
export const detachPurchaseProductsForBrowser = (options: {
  data: z.input<typeof purchaseProductMutationInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "purchase.detachProducts",
    type: "mutation",
    input: options.data,
    inputSchema: purchaseProductMutationInput,
    outputSchema: purchaseProductMutationOut,
    request: options.request,
    run: (context, input) => detachPurchaseProductsWorkflow(context, input),
  });
