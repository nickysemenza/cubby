import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { startEmailImport } from "~/server/purchase-import/email-actions";
import { correctEmailRelevance } from "~/server/purchase-import/gmail/relevance-correction";
import {
  commitPurchaseImport,
  preparePurchaseImport,
  purchaseImportOperationStatus,
} from "~/server/purchase-import/import-orders";
import {
  readMail,
  resolveMail,
  searchMail,
} from "~/server/purchase-import/mail-tool";
import { confirmMerchantVendorRule } from "~/server/purchase-import/merchant-vendor-rules";
import {
  prepareSourceOrderReconciliation,
  commitAcceptedSourceOrderReconciliation,
} from "~/server/purchase-import/reconciliation";
import {
  createEmailAccuracyEvaluation,
  listBlindEmailAccuracyItems,
  gradeEmailAccuracyItem,
  getEmailAccuracyReport,
} from "~/server/repo/email-accuracy";

export const purchaseImportHandlers = implementOperationDomain(
  purchaseImportContract,
  {
    correctEmailRelevance: (context, input) =>
      correctEmailRelevance(context.db, input, context.actorContext),
    emailAccuracyCreate: (context, input) =>
      createEmailAccuracyEvaluation(context.db, input, context.actorContext),
    emailAccuracyBlind: (context, input) =>
      listBlindEmailAccuracyItems(context.db, input, context.actorContext),
    emailAccuracyGrade: (context, input) =>
      gradeEmailAccuracyItem(context.db, input, context.actorContext),
    emailAccuracyReport: (context, input) =>
      getEmailAccuracyReport(context.db, input, context.actorContext),
    commitAcceptedReconciliation: (context, input) =>
      commitAcceptedSourceOrderReconciliation(
        context.db,
        input,
        context.actorContext,
      ),
    emailImport: (context, input) =>
      startEmailImport(context.db, input, context.actorContext),
    prepareReconciliation: (context, input) =>
      prepareSourceOrderReconciliation(context.db, input, context.actorContext),
    prepare: (context, input) =>
      preparePurchaseImport(context.db, input, context.actorContext),
    commit: (context, input) =>
      commitPurchaseImport(context.db, input, context.actorContext),
    operationStatus: (context, input) =>
      purchaseImportOperationStatus(context.db, input, context.actorContext),
    confirmMerchantVendor: (context, input) =>
      confirmMerchantVendorRule(context.db, input, context.actorContext),
    mailRead: (context, input) =>
      readMail(context.db, input, context.actorContext),
    mailSearch: (context, input) =>
      searchMail(context.db, input, context.actorContext),
    mailResolve: (context, input) =>
      resolveMail(context.db, input, context.actorContext),
  },
);
