import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import {
  createEmailAccuracyEvaluation,
  listBlindEmailAccuracyItems,
  gradeEmailAccuracyItem,
  getEmailAccuracyReport,
} from "~/server/domains/email/repo/email-accuracy";
import { startEmailImport } from "~/server/domains/purchase-import/email-actions";
import { decideEmailPurchase } from "~/server/domains/purchase-import/email-purchase-decision";
import {
  previewMailTriage,
  reclassifyEmails,
  rerunEmailPreview,
} from "~/server/domains/purchase-import/gmail/reclassify";
import { correctEmailRelevance } from "~/server/domains/purchase-import/gmail/relevance-correction";
import {
  commitPurchaseImport,
  preparePurchaseImport,
  purchaseImportOperationStatus,
} from "~/server/domains/purchase-import/import-orders";
import {
  readMail,
  resolveMail,
  searchMail,
} from "~/server/domains/purchase-import/mail-tool";
import { confirmMerchantVendorRule } from "~/server/domains/purchase-import/merchant-vendor-rules";
import {
  prepareSourceOrderReconciliation,
  commitAcceptedSourceOrderReconciliation,
} from "~/server/domains/purchase-import/reconciliation";
import { emailAccuracyViewReport } from "~/server/generic/entity-report/repo/email";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

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
    emailPurchaseDecide: (context, input) =>
      decideEmailPurchase(context.db, input, context.actorContext),
    emailReclassify: (context, input) =>
      reclassifyEmails(context.db, input, context.actorContext),
    emailPreviewRerun: (context, input) =>
      rerunEmailPreview(context.db, input, context.actorContext),
    emailAccuracyView: (context) =>
      emailAccuracyViewReport(context.db, context.actorContext),
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
    mailTriagePreview: (context, input) =>
      previewMailTriage(context.db, input, context.actorContext),
    mailSearch: (context, input) =>
      searchMail(context.db, input, context.actorContext),
    mailResolve: (context, input) =>
      resolveMail(context.db, input, context.actorContext),
  },
);
