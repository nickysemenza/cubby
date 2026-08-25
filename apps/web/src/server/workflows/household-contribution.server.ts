import {
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
  type suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import type { Database } from "~/server/db";
import { suggestFinancialTransferPairs } from "~/server/repo/financial-transfer-pairing";
import {
  householdContributionLedger,
  projectContribution,
} from "~/server/repo/household-contribution";

export {
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
};

export const householdContributionLedgerWorkflow = (
  db: Database,
  input: typeof householdContributionLedgerInput._output,
) => householdContributionLedger(db, input);

export const projectContributionWorkflow = (
  db: Database,
  input: typeof projectContributionInput._output,
) => projectContribution(db, input);

export const suggestFinancialTransferPairsWorkflow = (
  db: Database,
  input: typeof suggestFinancialTransferPairsInput._output,
) => suggestFinancialTransferPairs(db, input);
