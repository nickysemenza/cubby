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
      mcp: {
        name: "get_household_contribution_ledger",
        description:
          "Read the household-wide contribution ledger as of a date (today when omitted). Positions include Expenses and Ledger Transfers dated through that day; evidence-gap counts describe currently attached Financial Transaction evidence. This is read-only and never records attribution, transfers, or evidence.",
      },
      input: householdContributionLedgerInput,
      output: householdContributionLedgerOut,
    }),
    project: query({
      mcp: {
        name: "get_project_contribution",
        description:
          "Read whole-group cost, initial funding, consumption, and attribution gaps for one Project, optionally including descendants. Project reports include planned future Expenses and exclude later household-wide transfers. This is read-only.",
      },
      input: projectContributionInput,
      output: projectContributionOut,
    }),
  },
);
