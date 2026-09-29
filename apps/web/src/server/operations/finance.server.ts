import {
  financialTransactionContract,
  ledgerPartyContract,
} from "~/contracts/finance.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import { financialTransactionSourceOptions } from "~/server/repo/financial-transaction";
import {
  listMemberLogins,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import { merchantVendorInferenceFor } from "~/server/repo/merchant-vendor-inference";

export const ledgerPartyHandlers = implementOperationDomain(
  ledgerPartyContract,
  {
    memberLogins: (context) => listMemberLogins(context.db),
    setMemberLogin: async (context, input) => {
      await setMemberLoginParty(
        context.db,
        input.userId,
        input.ledgerParty,
        context.actorContext,
      );
      return listMemberLogins(context.db);
    },
  },
);

export const financialTransactionHandlers = implementOperationDomain(
  financialTransactionContract,
  {
    previewStatementImport: (context, input) =>
      previewFinancialStatementImport(context.db, input),
    sourceOptions: (context) => financialTransactionSourceOptions(context.db),
    vendorInference: (context, input) =>
      merchantVendorInferenceFor(context.db, input.merchant),
  },
);
