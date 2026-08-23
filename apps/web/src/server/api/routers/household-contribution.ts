import {
  applyHouseholdLedgerChangesInput,
  applyHouseholdLedgerChangesOut,
  financialTransferPairSuggestionsOut,
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  householdLedgerChangePreviewOut,
  previewHouseholdLedgerChangesInput,
  projectContributionInput,
  projectContributionOut,
  suggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import { suggestFinancialTransferPairs } from "~/server/repo/financial-transfer-pairing";
import {
  applyHouseholdLedgerChanges,
  householdContributionLedger,
  previewHouseholdLedgerChanges,
  projectContribution,
} from "~/server/repo/household-contribution";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

/**
 * Narrow orchestration boundary for the household attribution ledger.
 *
 * The repository owns planning, transactionality, and idempotency; this router
 * only supplies request context. Keeping that split prevents MCP and browser
 * callers from acquiring subtly different preview/apply behavior.
 */
export const householdContributionRouter = createTRPCRouter({
  previewChanges: protectedProcedure
    .input(previewHouseholdLedgerChangesInput)
    .output(strictOutput(householdLedgerChangePreviewOut))
    .query(({ ctx, input }) => previewHouseholdLedgerChanges(ctx.db, input)),
  applyChanges: protectedProcedure
    .input(applyHouseholdLedgerChangesInput)
    .output(strictOutput(applyHouseholdLedgerChangesOut))
    .mutation(({ ctx, input }) =>
      applyHouseholdLedgerChanges(ctx.db, input, ctx.actorContext),
    ),
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
