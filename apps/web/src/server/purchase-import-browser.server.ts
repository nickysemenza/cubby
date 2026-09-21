import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  listReceiptHunts,
  submitReceiptEvidence,
} from "~/server/purchase-import/receipt-evidence";
import { initiateImportRunEvidenceUpload } from "~/server/purchase-import/run-evidence";

export const purchaseImportHandlers = implementOperationDomain(
  purchaseImportContract,
  {
    initiateRunEvidenceUpload: (context, input) =>
      initiateImportRunEvidenceUpload(context.db, input, context.auth.userId),
    listReceiptHunts: (context) =>
      listReceiptHunts(context.db, context.actorContext),
    submitReceiptEvidence: (context, input) => {
      const queue = getPurchaseAgentQueue();
      if (!queue) throw new Error("Purchase Agent queue is unavailable");
      return submitReceiptEvidence(
        context.db,
        input,
        context.actorContext,
        queue,
      );
    },
  },
);
