import { householdContributionContract } from "~/contracts/household-contribution.contract";
import { suggestFinancialTransferPairs } from "~/server/domains/financial-transaction/repo/financial-transfer-pairing";
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
    transferPairs: (context, input) =>
      suggestFinancialTransferPairs(context.db, input),
  },
);
