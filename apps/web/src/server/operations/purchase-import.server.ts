import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { confirmMerchantVendorRule } from "~/server/purchase-import/hunts";
import {
  commitProductEnrichment,
  commitPurchaseImport,
  overwriteProductEnrichment,
  preparePurchaseImport,
  purchaseImportOperationStatus,
  validatePurchaseImport,
} from "~/server/purchase-import/import-orders";
import {
  listReceiptHunts,
  submitReceiptEvidence,
} from "~/server/purchase-import/receipt-evidence";
import { initiateRunEvidenceUpload } from "~/server/purchase-import/run-evidence";

export const purchaseImportHandlers = implementOperationDomain(
  purchaseImportContract,
  {
    initiateRunEvidenceUpload: (context, input) =>
      initiateRunEvidenceUpload(context.db, input, context.auth.userId),
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
    prepare: (context, input) =>
      preparePurchaseImport(context.db, input, context.actorContext),
    validate: (context, input) =>
      validatePurchaseImport(context.db, input, context.actorContext),
    commit: (context, input) =>
      commitPurchaseImport(context.db, input, context.actorContext),
    operationStatus: (context, input) =>
      purchaseImportOperationStatus(context.db, input, context.actorContext),
    confirmMerchantVendor: (context, input) =>
      confirmMerchantVendorRule(context.db, input, context.actorContext),
    commitProductEnrichment: (context, input) =>
      commitProductEnrichment(context.db, input, context.actorContext),
    overwriteProductEnrichment: (context, input) =>
      overwriteProductEnrichment(context.db, input, context.actorContext),
  },
);
