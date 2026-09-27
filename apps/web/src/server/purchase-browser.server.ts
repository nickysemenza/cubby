import { purchaseContract } from "~/contracts/purchase.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listPurchaseOrderMail } from "~/server/purchase-import/gmail/review";
import {
  linkExpensesToPurchaseWorkflow,
  purchaseProductsWorkflow,
  splitExpenseWorkflow,
} from "~/server/workflows/purchase.server";

export const purchaseHandlers = implementOperationDomain(purchaseContract, {
  orderMail: (context, input) => listPurchaseOrderMail(context.db, input),
  products: (context, input) => purchaseProductsWorkflow(context, input),
  link: (context, input) => linkExpensesToPurchaseWorkflow(context, input),
  split: (context, input) => splitExpenseWorkflow(context, input),
});
