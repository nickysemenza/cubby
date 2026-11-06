import { householdContributionContract } from "~/contracts/household-contribution.contract";
import {
  householdContributionLedger,
  projectContribution,
} from "~/server/domains/household-contribution/repo/reports";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const householdContributionHandlers = implementOperationDomain(
  householdContributionContract,
  {
    ledger: (context, input) => householdContributionLedger(context.db, input),
    project: (context, input) => projectContribution(context.db, input),
  },
);
