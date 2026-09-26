import {
  financialTransactionContract,
  ledgerPartyContract,
} from "~/contracts/finance.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import {
  listMemberLogins,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import {
  financialTransactionSourceOptionsWorkflow,
  merchantVendorInferenceWorkflow,
} from "~/server/workflows/finance.server";

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
      previewFinancialStatementImport(context.readDb, input),
    sourceOptions: (context) =>
      financialTransactionSourceOptionsWorkflow(context.readDb),
    vendorInference: (context, input) =>
      merchantVendorInferenceWorkflow(context.readDb, input),
  },
);
