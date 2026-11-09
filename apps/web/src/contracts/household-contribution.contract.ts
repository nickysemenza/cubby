import {
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
} from "@cubby/schemas/household-contribution";

import { defineContract, query } from "~/contracts/define";

export const householdContributionContract = defineContract(
  "householdContribution",
  {
    ledger: query({
      readPolicy: "strong",
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
  },
  { exposure: "capability", mcpToolGroup: "finance" },
);
