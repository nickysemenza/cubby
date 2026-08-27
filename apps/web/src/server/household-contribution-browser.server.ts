import { householdContribution } from "~/app/finance/household-contribution.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  householdContributionLedgerWorkflow,
  projectContributionWorkflow,
} from "~/server/workflows/household-contribution.server";

export const householdContributionHandlers = implementOperationDomain(
  householdContribution,
  {
    ledger: (context, input) =>
      householdContributionLedgerWorkflow(context.readDb, input),
    project: (context, input) =>
      projectContributionWorkflow(context.readDb, input),
  },
);
