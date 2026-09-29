import {
  financialTransferPairSuggestionsOut,
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
  suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";

import { defineContract, query } from "~/contracts/define";

export const householdContributionContract = defineContract(
  "householdContribution",
  {
    ledger: query({
      input: householdContributionLedgerInput,
      output: householdContributionLedgerOut,
    }),
    project: query({
      input: projectContributionInput,
      output: projectContributionOut,
    }),
    /** Read-only candidate worklist of opposite-signed cross-account pairs (MCP `finance_read`). */
    transferPairs: query({
      http: false,
      input: suggestFinancialTransferPairsInput,
      output: financialTransferPairSuggestionsOut,
    }),
  },
);
