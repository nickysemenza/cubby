import { purchaseContract } from "~/contracts/purchase.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  linkExpensesToPurchaseWorkflow,
  purchaseProductsWorkflow,
  splitExpenseWorkflow,
} from "~/server/workflows/purchase.server";

export const purchaseHandlers = implementOperationDomain(purchaseContract, {
  products: (context, input) => purchaseProductsWorkflow(context, input),
  link: (context, input) => linkExpensesToPurchaseWorkflow(context, input),
  split: (context, input) => splitExpenseWorkflow(context, input),
});
