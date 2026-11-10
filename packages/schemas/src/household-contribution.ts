import { z } from "zod";
import { plainDate } from "./base-entity";
import {
  financialTransactionShortcode,
  expenseShortcode,
  ledgerPartyShortcode,
  ledgerTransferShortcode,
  projectShortcode,
} from "./identifiers";
import { ledgerPartyKind } from "./ledger-party";
import { money } from "./money";

const ledgerReportPartyOut = z.object({
  id: ledgerPartyShortcode,
  kind: ledgerPartyKind,
  name: z.string(),
});

export const householdContributionLedgerInput = z.object({
  asOf: plainDate.optional(),
});
export type HouseholdContributionLedgerInput = z.infer<
  typeof householdContributionLedgerInput
>;

const expenseContributionGapCode = z.enum([
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
  /**
   * Funder of a future Expense — not due yet, so nobody has paid it. Aggregated
   * like `beneficiary_assumed_household`: it is a status, not a worklist, and
   * enumerating scheduled instalments is the noise this reporting exists to
   * avoid. Only reachable from the project report; the household ledger scopes
   * `includeFuture: false` and never sees these rows.
   */
  "funder_not_yet_paid",
]);
const householdContributionGapCode = z.union([
  expenseContributionGapCode,
  z.literal("transfer_evidence_one_sided"),
]);
export type HouseholdContributionGapCode = z.infer<
  typeof householdContributionGapCode
>;

const householdContributionGapOut = z.object({
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
const projectContributionGapOut = z.object({
  code: expenseContributionGapCode,
  amount: money.optional(),
  count: z.number().int().positive().optional(),
  targetIds: z.array(expenseShortcode),
});

export const householdContributionLedgerOut = z.object({
  asOf: plainDate,
  parties: z.array(
    z.object({
      party: ledgerReportPartyOut,
      consumed: money,
      initiallyOutlaid: money,
      transfersSent: money,
      transfersReceived: money,
      /** Ledger Transfers from this party to itself; excluded from sent/received. */
      internalMoves: z.object({
        count: z.number().int().nonnegative(),
        amount: money,
      }),
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
  /**
   * The blended figure — actual + committed − credits. Unchanged, because
   * everything downstream reads it; the three components below are additive.
   */
  wholeGroupCost: money,
  /** cost > 0, already spent. */
  actualSpend: money,
  /** cost > 0 and flagged future — committed but not yet due. */
  committedSpend: money,
  /** Σ|cost| where cost < 0 — credits offsetting spend, positive magnitude. */
  creditsReceived: money,
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

/** One reviewed suggestion: the positive (outflow) and negative (inflow) legs. */
export const acceptFinancialTransferPairInput = z.object({
  outflowTransactionId: financialTransactionShortcode,
  inflowTransactionId: financialTransactionShortcode,
});
export type AcceptFinancialTransferPairInput = z.infer<
  typeof acceptFinancialTransferPairInput
>;

/**
 * A refused precondition is data, not an error: MCP clients reject
 * `structuredContent` on `isError`, and the reason names the record to fix.
 */
export const acceptFinancialTransferPairOut = z.discriminatedUnion(
  "canProceed",
  [
    z.object({
      canProceed: z.literal(true),
      transferId: ledgerTransferShortcode,
      fromPartyId: ledgerPartyShortcode,
      toPartyId: ledgerPartyShortcode,
      amount: money,
      date: plainDate,
      /** Same sending and receiving party; reported apart from sent/received. */
      internalMove: z.boolean(),
    }),
    z.object({ canProceed: z.literal(false), reason: z.string() }),
  ],
);
export type AcceptFinancialTransferPairOut = z.infer<
  typeof acceptFinancialTransferPairOut
>;
