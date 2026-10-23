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
      description:
        "The household-wide contribution ledger as of a date (today when omitted). Positions include Expenses and Ledger Transfers dated through that day; evidence-gap counts describe currently attached Financial Transaction evidence. Never records attribution, transfers, or evidence.",
      input: householdContributionLedgerInput,
      output: householdContributionLedgerOut,
    }),
    project: query({
      description:
        "Whole-group cost, initial funding, consumption, and attribution gaps for one Project, optionally including descendants. Includes planned future Expenses and excludes later household-wide transfers.",
      input: projectContributionInput,
      output: projectContributionOut,
    }),
    /** Read-only candidate worklist of opposite-signed cross-account pairs (MCP `finance_read`). */
    transferPairs: query({
      description:
        "An ad hoc candidate lookup pairing selected Financial Transaction evidence with opposite-signed, different-account matches. The transfer_pair Suggestions queue (suggestions.list family transfer_pair) is the primary review path; use this to inspect specific transactions. It never creates Ledger Transfers, attaches evidence, or decides a match; to pair two existing legs directly, pass a reviewed candidate's outflowTransactionId and inflowTransactionId to finance.accept_transfer_pair.",
      input: suggestFinancialTransferPairsInput,
      output: financialTransferPairSuggestionsOut,
    }),
  },
  { exposure: "capability", mcpToolGroup: "finance" },
);
