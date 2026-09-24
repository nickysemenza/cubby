import {
  financialAccountContract,
  financialTransactionContract,
  ledgerPartyContract,
} from "~/contracts/finance.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const financialAccount = defineOperationDomain(
  financialAccountContract,
  {
    options: { tags: [["financialAccount", "options"]] },
  },
);

export const ledgerParty = defineOperationDomain(ledgerPartyContract, {
  options: { tags: [["ledgerParty", "options"]] },
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
