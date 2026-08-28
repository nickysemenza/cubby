import {
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
} from "@cubby/schemas/household-contribution";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const householdContribution = defineOperationDomain(
  "householdContribution",
  {
    ledger: query({
      input: householdContributionLedgerInput,
      output: householdContributionLedgerOut,
      tags: [["householdContribution", "ledger"]],
    }),
    project: query({
      input: projectContributionInput,
      output: projectContributionOut,
      tags: [["householdContribution", "project"]],
    }),
  },
);
