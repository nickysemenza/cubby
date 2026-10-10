import { purchaseImportContract } from "~/contracts/purchase-import.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
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

export const purchaseImportHandlers = implementOperationDomain(
  purchaseImportContract,
  {
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
