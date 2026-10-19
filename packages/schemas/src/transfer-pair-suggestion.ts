import { z } from "zod";

import { plainDate } from "./base-entity";
import { generatedFinancialTransactionKindValues } from "./generated/entity-field-schemas.financialTransaction.gen";
import { financialTransactionSourceRef } from "./financial-transaction-fields";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
  ledgerPartyShortcode,
} from "./identifiers";

/**
 * Where a leg's money is recorded: an existing FinancialTransaction, an
 * unmatched statement charge the apply creates, or a hand-entered cash leg
 * the apply creates on the owner's one cash account.
 */
export const transferPairLegOrigin = z.enum([
  "transaction",
  "statement",
  "cash",
]);
export type TransferPairLegOrigin = z.infer<typeof transferPairLegOrigin>;

/**
 * The declared Decision reading of one leg's descriptor in its pair: whether
 * it explicitly records money moving between accounts. Generic payment,
 * deposit, ACH, check or repayment descriptors are `insufficient_evidence`.
 */
export const transferPairMovementChoices = [
  "account_move",
  "payment",
  "insufficient_evidence",
] as const;
export const transferPairMovementLabel = z.object({
  choice: z.enum(transferPairMovementChoices),
  confidence: z.enum(["low", "medium", "high"]),
  model: z.string(),
});
export type TransferPairMovementLabel = z.infer<
  typeof transferPairMovementLabel
>;

/**
 * `explicit` only from a high-confidence `account_move` label. A recorded
 * transfer kind or a provider transfer category alone stays `weak`: a cashed
 * check the provider filed under Transfer must never pair clean.
 */
export const transferPairMovement = z.enum(["explicit", "weak"]);
export type TransferPairMovement = z.infer<typeof transferPairMovement>;

/** Recorded and provider values that retrieved the leg; they never make it explicit. */
export const transferPairLegSignals = z.object({
  /** The recorded kind, or the provider-category rule's kind for a charge. */
  kind: z.enum(generatedFinancialTransactionKindValues).nullable(),
  providerCategory: z.string().nullable(),
});

/** One provider charge: all observations of it share this identity. */
export const transferPairCharge = z.object({
  source: z.string().min(1),
  chargeKey: z.string().min(1),
});

/**
 * Another unresolved record on the leg's account with the same amount near
 * its date: possibly this money again from an overlapping export. It blocks a
 * clean pair, and on a statement leg blocks creating it, until the statement
 * suggestions resolve it.
 */
export const transferPairOverlap = z.object({
  transactionId: financialTransactionShortcode.nullable(),
  charge: transferPairCharge.nullable(),
  date: plainDate,
  description: z.string().nullable(),
});

export const transferPairOwner = z.object({
  id: ledgerPartyShortcode,
  name: z.string(),
});

export const transferPairLeg = z.object({
  /** Stable identity: `ftx:<FTX code>`, `stmt:<source>:<chargeKey>` or `cash:<FAC code>:<outflow key>`. */
  key: z.string().min(1),
  origin: transferPairLegOrigin,
  accountId: financialAccountShortcode,
  accountName: z.string(),
  /** The account identity kind, e.g. `cash`, `bank_account`, `credit_card`. */
  accountKind: z.string(),
  owner: transferPairOwner.nullable(),
  /** Null until the apply creates a statement or cash leg. */
  transactionId: financialTransactionShortcode.nullable(),
  charge: transferPairCharge.nullable(),
  /** Cubby convention: positive is money out of the account. */
  amount: z.number(),
  date: plainDate,
  merchant: z.string().nullable(),
  description: z.string().nullable(),
  /** The kind the leg is recorded as, or will be created as. */
  kind: z.enum(generatedFinancialTransactionKindValues),
  signals: transferPairLegSignals,
  movementLabel: transferPairMovementLabel.nullable(),
  movement: transferPairMovement,
  /** Settlement refs the leg holds, or every ref a created leg will carry. */
  refs: z.array(financialTransactionSourceRef),
  overlaps: z.array(transferPairOverlap),
});
export type TransferPairLeg = z.infer<typeof transferPairLeg>;

/** Another candidate for one side, counted for uniqueness even when weak. */
export const transferPairCompetitor = z.object({
  /** The pair's leg this candidate competes for the opposite of. */
  against: z.enum(["outflow", "inflow"]),
  leg: transferPairLeg.pick({
    key: true,
    origin: true,
    accountId: true,
    accountName: true,
    transactionId: true,
    amount: true,
    date: true,
    description: true,
    movement: true,
  }),
  dateGapDays: z.number().int().nonnegative(),
});

/** Why a pair is not clean; every entry is something a member reviews. */
export const transferPairBlocker = z.enum([
  "competing_candidates",
  "date_gap",
  "owner_missing",
  "owners_differ",
  "weak_movement",
  "unresolved_overlap",
  "cash_leg_missing",
]);
export type TransferPairBlocker = z.infer<typeof transferPairBlocker>;

export const transferPairJudgment = z.object({
  /** `<outflow key>~<inflow key>`. */
  key: z.string().min(1),
  outflow: transferPairLeg,
  inflow: transferPairLeg,
  amount: z.number().positive(),
  /** The earlier leg's date, which the LedgerTransfer records. */
  date: plainDate,
  dateGapDays: z.number().int().nonnegative(),
  /** `internal`: one owner; `between_owners` records money between people. */
  move: z.enum(["internal", "between_owners", "unowned"]),
  competitors: z.array(transferPairCompetitor),
  blockers: z.array(transferPairBlocker),
  /** Human-readable reasons, one per blocker. */
  reasons: z.array(z.string()),
  /**
   * Bulk-acceptable by a member's Accept clean: no blockers. Both legs' labels
   * are necessary but never sufficient, and never authorize an apply.
   */
  clean: z.boolean(),
  /** Whether a reviewed apply can proceed, and the refusal when it cannot. */
  apply: z.object({
    available: z.boolean(),
    reason: z.string().nullable(),
  }),
});
export type TransferPairJudgment = z.infer<typeof transferPairJudgment>;

/** A statement charge's found pair, for the statement family's clean test. */
export const statementTransferPairRef = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  clean: z.boolean(),
});
export type StatementTransferPairRef = z.infer<typeof statementTransferPairRef>;
