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
      input: householdContributionLedgerInput,
      output: householdContributionLedgerOut,
    }),
    project: query({
      input: projectContributionInput,
      output: projectContributionOut,
    }),
  },
);
