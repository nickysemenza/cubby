import {
  financialTransferPairSuggestionsOut,
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  projectContributionInput,
  projectContributionOut,
  suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import { suggestFinancialTransferPairs } from "~/server/repo/financial-transfer-pairing";
import {
  householdContributionLedger,
  projectContribution,
} from "~/server/repo/household-contribution";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

/**
 * Narrow orchestration boundary for the household attribution ledger.
 *
 * Repositories own the report and candidate-worklist queries; this router only
 * supplies request context so MCP and browser callers share the same reads.
 */
export const householdContributionRouter = createTRPCRouter({
  ledger: protectedProcedure
    .input(householdContributionLedgerInput)
    .output(strictOutput(householdContributionLedgerOut))
    .query(({ ctx, input }) => householdContributionLedger(ctx.db, input)),
  project: protectedProcedure
    .input(projectContributionInput)
    .output(strictOutput(projectContributionOut))
    .query(({ ctx, input }) => projectContribution(ctx.db, input)),
  suggestTransferPairs: protectedProcedure
    .input(suggestFinancialTransferPairsInput)
    .output(strictOutput(financialTransferPairSuggestionsOut))
    .query(({ ctx, input }) => suggestFinancialTransferPairs(ctx.db, input)),
});
