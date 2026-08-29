import { z } from "zod";
import { plainDate } from "./base-entity";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
  expenseShortcode,
  ledgerPartyShortcode,
  ledgerTransferShortcode,
  projectShortcode,
} from "./identifiers";
import { ledgerPartyKind } from "./ledger-party";
import { money } from "./money";

export const ledgerReportPartyOut = z.object({
  id: ledgerPartyShortcode,
  kind: ledgerPartyKind,
  name: z.string(),
});
export type LedgerReportPartyOut = z.infer<typeof ledgerReportPartyOut>;

export type LedgerPartyRefOut = LedgerReportPartyOut;

export const householdContributionLedgerInput = z.object({
  asOf: plainDate.optional(),
});
export type HouseholdContributionLedgerInput = z.infer<
  typeof householdContributionLedgerInput
>;

export const expenseContributionGapCode = z.enum([
  "missing_beneficiaries",
  "missing_funders",
  "partial_beneficiaries",
  "partial_funders",
  "unpriced_expense",
  /**
   * Consumption was defaulted to the household because nothing was recorded.
   * Informational, and deliberately AGGREGATED into one entry carrying a count
   * — emitting one per expense would reproduce the wall of noise this
   * derivation exists to remove.
   */
  "beneficiary_assumed_household",
  /**
   * The payment chain resolved, but every paying account has no owner. The one
   * actionable new code: it names a fixable thing and points at real expenses.
   */
  "funder_account_unowned",
]);
export const householdContributionGapCode = z.union([
  expenseContributionGapCode,
  z.literal("transfer_evidence_one_sided"),
]);
export type HouseholdContributionGapCode = z.infer<
  typeof householdContributionGapCode
>;

export const householdContributionGapOut = z.object({
  code: householdContributionGapCode,
  amount: money.optional(),
  /**
   * How many records the gap covers. Present only on aggregated codes, where
   * `targetIds` is deliberately empty rather than thousands long.
   */
  count: z.number().int().positive().optional(),
  targetIds: z.array(z.union([expenseShortcode, ledgerTransferShortcode])),
});
export type HouseholdContributionGapOut = z.infer<
  typeof householdContributionGapOut
>;

/** Project reports contain Expense attribution gaps, never household transfers. */
export const projectContributionGapOut = z.object({
  code: expenseContributionGapCode,
  amount: money.optional(),
  count: z.number().int().positive().optional(),
  targetIds: z.array(expenseShortcode),
});
export type ProjectContributionGapOut = z.infer<
  typeof projectContributionGapOut
>;

export const householdContributionLedgerOut = z.object({
  asOf: plainDate,
  parties: z.array(
    z.object({
      party: ledgerReportPartyOut,
      consumed: money,
      initiallyOutlaid: money,
      transfersSent: money,
      transfersReceived: money,
      netContribution: money,
      position: money,
    }),
  ),
  unattributed: z.object({ consumption: money, funding: money }),
  checks: z.object({
    expenseTotal: money,
    consumedTotal: money,
    fundedTotal: money,
    transferNet: money,
    positionNet: money,
  }),
  gaps: z.array(householdContributionGapOut),
  gapsTruncated: z.boolean(),
});
export type HouseholdContributionLedgerOut = z.infer<
  typeof householdContributionLedgerOut
>;

export const projectContributionInput = z.object({
  projectId: projectShortcode,
  includeSubprojects: z.boolean().default(true),
});
export type ProjectContributionInput = z.infer<typeof projectContributionInput>;

export const projectContributionOut = z.object({
  projectId: projectShortcode,
  wholeGroupCost: money,
  householdInitialExposure: money,
  guestInitialFunding: money,
  unattributedConsumption: money,
  unattributedInitialFunding: money,
  householdConsumed: money,
  parties: z.array(z.object({ party: ledgerReportPartyOut, consumed: money })),
  funders: z.array(
    z.object({ party: ledgerReportPartyOut, initiallyFunded: money }),
  ),
  gaps: z.array(projectContributionGapOut),
  /** Matches the household ledger: project gaps are capped, not unbounded. */
  gapsTruncated: z.boolean(),
});
export type ProjectContributionOut = z.infer<typeof projectContributionOut>;

export const suggestFinancialTransferPairsInput = z.object({
  transactionIds: z.array(financialTransactionShortcode).min(1).max(200),
  maxDateDistanceDays: z.number().int().min(0).max(14).default(5),
  maxCandidatesPerTransaction: z.number().int().min(1).max(10).default(3),
});
export type SuggestFinancialTransferPairsInput = z.infer<
  typeof suggestFinancialTransferPairsInput
>;

export const financialTransferPairSuggestionsOut = z.object({
  status: z.enum(["proposed", "ambiguous", "no_match"]),
  suggestions: z.array(
    z.object({
      transactionId: financialTransactionShortcode,
      status: z.enum(["proposed", "ambiguous", "no_match"]),
      candidates: z.array(
        z.object({
          transactionId: financialTransactionShortcode,
          fromAccountId: financialAccountShortcode,
          toAccountId: financialAccountShortcode,
          from: ledgerReportPartyOut.nullable(),
          to: ledgerReportPartyOut.nullable(),
          amount: money,
          dateDistanceDays: z.number().int().nonnegative(),
          reasons: z.array(z.string()),
          transferId: ledgerTransferShortcode.optional(),
        }),
      ),
    }),
  ),
});
export type FinancialTransferPairSuggestionsOut = z.infer<
  typeof financialTransferPairSuggestionsOut
>;
