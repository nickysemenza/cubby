import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import {
  commitPurchaseImport,
  preparePurchaseImport,
  purchaseImportOperationStatus,
} from "~/server/domains/purchase-import/operations/import-orders";
import {
  readMail,
  readMailImportOutcomes,
  resolveMail,
  searchMail,
} from "~/server/domains/purchase-import/operations/mail-tool";
import { startEmailImport } from "~/server/domains/purchase-import/repo/email-actions";
import { decideEmailPurchase } from "~/server/domains/purchase-import/repo/email-purchase-decision";
import { correctEmailRelevance } from "~/server/domains/purchase-import/repo/gmail/relevance-correction";
import {
  prepareSourceOrderReconciliation,
  commitAcceptedSourceOrderReconciliation,
} from "~/server/domains/purchase-import/repo/reconciliation";
import {
  previewMailTriage,
  reclassifyEmails,
  rerunEmailPreview,
} from "~/server/domains/purchase-import/service/gmail/reclassify";
import { sweepImportedProductCategories } from "~/server/domains/purchase-import/service/import-category-sweep";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const purchaseImportHandlers = implementOperationDomain(
  purchaseImportContract,
  {
    correctEmailRelevance: (context, input) =>
      correctEmailRelevance(context.db, input, context.actorContext),
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
    prepareReconciliation: (context, input) =>
      prepareSourceOrderReconciliation(context.db, input, context.actorContext),
    prepare: (context, input) =>
      preparePurchaseImport(context.db, input, context.actorContext),
    commit: (context, input) =>
      commitPurchaseImport(context.db, input, context.actorContext, undefined, {
        onProductsCreated: (productIds) =>
          sweepImportedProductCategories(context, productIds),
      }),
    operationStatus: (context, input) =>
      purchaseImportOperationStatus(context.db, input, context.actorContext),
    mailImportOutcomes: (context, input) =>
      readMailImportOutcomes(context.db, input, context.actorContext),
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
