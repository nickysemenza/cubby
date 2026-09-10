import { suggestFinancialTransferPairs } from "~/server/repo/financial-transfer-pairing";
import {
  householdContributionLedger,
  projectContribution,
} from "~/server/repo/household-contribution";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

export const householdContributionLedgerWorkflow = defineWorkflowOperation(
  "householdContribution.ledger",
  householdContributionLedger,
);

export const projectContributionWorkflow = defineWorkflowOperation(
  "householdContribution.project",
  projectContribution,
);

export const suggestFinancialTransferPairsWorkflow = defineWorkflowOperation(
  "householdContribution.suggestFinancialTransferPairs",
  suggestFinancialTransferPairs,
);
