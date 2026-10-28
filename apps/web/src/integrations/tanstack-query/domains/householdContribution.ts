import { householdContributionContract } from "~/contracts/household-contribution.contract";

import { defineOperationDomain } from "../operation-catalog";

export const householdContribution = /* @__PURE__ */ defineOperationDomain(
  householdContributionContract,
);
