import { householdContributionContract } from "~/contracts/household-contribution.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  householdContributionLedgerWorkflow,
  projectContributionWorkflow,
} from "~/server/workflows/household-contribution.server";

export const householdContributionHandlers = implementOperationDomain(
  householdContributionContract,
  {
    ledger: (context, input) =>
      householdContributionLedgerWorkflow(context.readDb, input),
    project: (context, input) =>
      projectContributionWorkflow(context.readDb, input),
  },
);
