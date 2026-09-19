import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  listReceiptHunts,
  submitReceiptEvidence,
} from "~/server/purchase-import/receipt-evidence";

export const purchaseImportHandlers = implementOperationDomain(
  purchaseImportContract,
  {
    listReceiptHunts: (context) =>
      listReceiptHunts(context.db, context.actorContext),
    submitReceiptEvidence: (context, input) =>
      submitReceiptEvidence(context.db, input, context.actorContext),
  },
);
