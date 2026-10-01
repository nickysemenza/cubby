import { householdContributionContract } from "~/contracts/household-contribution.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { suggestFinancialTransferPairs } from "~/server/repo/financial-transfer-pairing";
import {
  householdContributionLedger,
  projectContribution,
} from "~/server/repo/household-contribution/reports";

export const householdContributionHandlers = implementOperationDomain(
  householdContributionContract,
  {
    ledger: (context, input) => householdContributionLedger(context.db, input),
    project: (context, input) => projectContribution(context.db, input),
    transferPairs: (context, input) =>
      suggestFinancialTransferPairs(context.db, input),
  },
);
