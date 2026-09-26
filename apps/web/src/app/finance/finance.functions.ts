import {
  financialTransactionContract,
  ledgerPartyContract,
} from "~/contracts/finance.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const ledgerParty = defineOperationDomain(ledgerPartyContract, {
  memberLogins: { tags: [["ledgerParty", "memberLogins"]] },
  // A login's party decides which runs it may control.
  setMemberLogin: { invalidates: ripple.memberLogins },
});

export const financialTransaction = defineOperationDomain(
  financialTransactionContract,
  {
    previewStatementImport: {
      tags: [["financialTransaction"], ["financialAccount"]],
    },
    sourceOptions: { tags: [["financialTransaction", "sourceOptions"]] },
    vendorInference: {
      tags: [["financialTransaction"], ["purchase"], ["vendor"]],
    },
  },
);
