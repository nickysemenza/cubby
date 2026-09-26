import { householdContributionContract } from "~/contracts/household-contribution.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  householdContributionLedger,
  projectContribution,
} from "~/server/repo/household-contribution";

export const householdContributionHandlers = implementOperationDomain(
  householdContributionContract,
  {
    ledger: (context, input) =>
      householdContributionLedger(context.readDb, input),
    project: (context, input) => projectContribution(context.readDb, input),
  },
);
