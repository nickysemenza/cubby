import { householdContributionContract } from "~/contracts/household-contribution.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const householdContribution = defineOperationDomain(
  householdContributionContract,
  {
    ledger: { tags: [["householdContribution", "ledger"]] },
    project: { tags: [["householdContribution", "project"]] },
  },
);
