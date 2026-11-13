import {
  type FinancialTransactionKind,
  financialTransactionSettlementViolation,
} from "@cubby/schemas/financial-transaction";
import { type FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import {
  parseShortcodeFor,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import {
  transferPairJudgment,
  type TransferPairBlocker,
  type TransferPairJudgment,
  type TransferPairLeg,
  type TransferPairMovementLabel,
} from "@cubby/schemas/transfer-pair-suggestion";
import { cents } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { uniqBy } from "es-toolkit";

import { plainDateDaysBetween } from "~/lib/household-date";
import {
  chargeId,
  type ChargeRef,
} from "~/server/domains/transaction-import/policy/charge-identity";
import {
  foldProviderCategory,
  MONEY_MOVE_KINDS,
  statementTransactionKind,
} from "~/server/domains/transaction-import/policy/statement-transaction-kind";
import { canonicalJson } from "~/server/lib/canonical-json";

/** Candidates: the opposite leg posted within this many days. */
const CANDIDATE_WINDOW_DAYS = 5;

/** A clean pair's legs are at most this many days apart. */
const CLEAN_GAP_DAYS = 3;

/** Another record of the same money lands within this window (the statement family's nearby rule). */
const OVERLAP_WINDOW_DAYS = 3;

/** Pool reach around the seeds: a candidate's competitors and overlaps included. */
export const POOL_WINDOW_DAYS = 2 * CANDIDATE_WINDOW_DAYS;

/** Kinds that move money between accounts; they retrieve a leg, never prove it. */
export const MONEY_MOVES = new Set<FinancialTransactionKind>(MONEY_MOVE_KINDS);

/**
 * Exact provider category values for a cash withdrawal, folded as
 * `statementTransactionKind` folds categories. Provider metadata, not a
 * descriptor reading: it only retrieves a bank leg for a cash-leg offer.
 */
const CASH_WITHDRAWAL_CATEGORIES = new Set([
  "cash atm",
  "atm",
  "atm cash",
  "cash withdrawal",
  "atm withdrawal",
]);

export type Account = {
  id: string;
  shortcode: string;
  name: string;
  kind: string;
  owner: { uuid: string; id: string; name: string } | null;
};

/** One record that can be a leg, before it is placed in a pair. */
export type LegFacts = {
  key: string;
  origin: "transaction" | "statement";
  account: Account;
  transactionCode: FinancialTransactionShortcode | null;
  charge: ChargeRef | null;
  /** Imports observing a statement leg: two rows of one export are two charges. */
  imports: ReadonlySet<string>;
  amount: number;
  date: string;
  merchant: string | null;
  description: string | null;
  notes: string | null;
  recordedKind: FinancialTransactionKind | null;
  providerCategory: string | null;
  /** The provider-category rule's kind, when a rule chose it. */
  ruleKind: FinancialTransactionKind | null;
  refs: FinancialTransactionSourceRef[];
  /** Same-account transactions a statement leg may already be recorded as. */
  transactionOverlaps: TransferPairLeg["overlaps"];
  seed: boolean;
  cashWithdrawal: boolean;
};

export type Pair = {
  judgment: TransferPairJudgment;
  outflowAccountId: string;
  inflowAccountId: string;
};

const dayGap = (a: string, b: string) => Math.abs(plainDateDaysBetween(a, b));

export const isSeed = (leg: {
  recordedKind: FinancialTransactionKind | null;
  ruleKind: FinancialTransactionKind | null;
  cashWithdrawal: boolean;
}) =>
  (leg.recordedKind !== null && MONEY_MOVES.has(leg.recordedKind)) ||
  (leg.ruleKind !== null && MONEY_MOVES.has(leg.ruleKind)) ||
  leg.cashWithdrawal;

export const categorySignals = (
  sourceCategory: string | null,
  amount: number,
) => {
  const rule = statementTransactionKind({ sourceCategory, amount });
  return {
    ruleKind: rule.kindSource === "rule" ? rule.kind : null,
    cashWithdrawal:
      amount > 0 &&
      sourceCategory !== null &&
      CASH_WITHDRAWAL_CATEGORIES.has(foldProviderCategory(sourceCategory)),
  };
};

// ------------------------------------------------------------- judgment
const explicit = (label: TransferPairMovementLabel | null) =>
  label?.choice === "account_move" && label.confidence === "high";

const legName = (leg: TransferPairLeg) =>
  `${leg.transactionId ?? leg.accountId} (${leg.accountName})`;

/**
 * Derives movement, blockers, clean and apply availability from a pair's
 * facts and labels. Labels can only remove `weak_movement`; every other
 * blocker is structural, so no label makes a pair clean on its own.
 */
function derive(judgment: TransferPairJudgment): TransferPairJudgment {
  const withMovement = (leg: TransferPairLeg): TransferPairLeg => ({
    ...leg,
    movement: explicit(leg.movementLabel) ? "explicit" : "weak",
  });
  const outflow = withMovement(judgment.outflow);
  const inflow = withMovement(judgment.inflow);
  const move =
    !outflow.owner || !inflow.owner
      ? "unowned"
      : outflow.owner.id === inflow.owner.id
        ? "internal"
        : "between_owners";
  const blockers: TransferPairBlocker[] = [];
  const reasons: string[] = [];
  const block = (blocker: TransferPairBlocker, reason: string) => {
    blockers.push(blocker);
    reasons.push(reason);
  };
  if (judgment.competitors.length)
    block(
      "competing_candidates",
      `${judgment.competitors.length} other record(s) could be the opposite leg: ${judgment.competitors
        .map((competitor) => competitor.leg.transactionId ?? competitor.leg.key)
        .join(", ")}.`,
    );
  if (judgment.dateGapDays > CLEAN_GAP_DAYS)
    block(
      "date_gap",
      `The legs are ${judgment.dateGapDays} days apart; a clean pair is at most ${CLEAN_GAP_DAYS}.`,
    );
  for (const leg of [outflow, inflow])
    if (!leg.owner)
      block(
        "owner_missing",
        `Account ${leg.accountId} (${leg.accountName}) has no owner.`,
      );
  if (move === "between_owners")
    block(
      "owners_differ",
      `${outflow.owner!.name} owns ${outflow.accountName} and ${inflow.owner!.name} owns ${inflow.accountName}: accepting records money moving between them.`,
    );
  // A cash leg to be created has no descriptor; its own blocker covers it.
  const weak = [outflow, inflow].filter(
    (leg) => leg.movement === "weak" && leg.origin !== "cash",
  );
  if (weak.length)
    block(
      "weak_movement",
      `No confident descriptor reading says ${weak.map(legName).join(" and ")} moved money between accounts.`,
    );
  const overlapping = [outflow, inflow].filter((leg) => leg.overlaps.length);
  if (overlapping.length)
    block(
      "unresolved_overlap",
      `${overlapping.map(legName).join(" and ")} may also be recorded by another export or transaction; resolve the statement suggestions first.`,
    );
  if (inflow.origin === "cash")
    block(
      "cash_leg_missing",
      `No cash leg is recorded; accepting creates one on ${inflow.accountName} for the full ${judgment.amount}, any ATM fee included.`,
    );
  const unowned = [outflow, inflow].find((leg) => !leg.owner);
  const creatingOverlap = [outflow, inflow].find(
    (leg) => leg.origin === "statement" && leg.overlaps.length,
  );
  return {
    ...judgment,
    outflow,
    inflow,
    move,
    blockers,
    reasons,
    clean: blockers.length === 0,
    apply: unowned
      ? {
          available: false,
          reason: `Set an owner on account ${unowned.accountId} (${unowned.accountName}) before accepting this pair.`,
        }
      : creatingOverlap
        ? {
            available: false,
            reason: `${legName(creatingOverlap)} may already be recorded by another export or transaction; resolve its statement suggestions before creating it.`,
          }
        : { available: true, reason: null },
  };
}

/** The pair with these legs' labels; absent keys keep their label. */
export function labelTransferPair(
  judgment: TransferPairJudgment,
  labels: {
    outflow?: TransferPairMovementLabel | null;
    inflow?: TransferPairMovementLabel | null;
  },
): TransferPairJudgment {
  return transferPairJudgment.parse(
    derive({
      ...judgment,
      outflow: {
        ...judgment.outflow,
        movementLabel:
          labels.outflow === undefined
            ? judgment.outflow.movementLabel
            : labels.outflow,
      },
      inflow: {
        ...judgment.inflow,
        movementLabel:
          labels.inflow === undefined
            ? judgment.inflow.movementLabel
            : labels.inflow,
      },
    }),
  );
}

/** Publication fingerprint: the evidence plus any labels. */
export const fingerprintTransferPair = (judgment: TransferPairJudgment) =>
  sha256Hex(canonicalJson({ revision: TRANSFER_PAIR_REVISION, judgment }));

/** The rule evidence alone: labels and what they derive are stripped. */
export const transferPairEvidenceFingerprint = (
  judgment: TransferPairJudgment,
) =>
  fingerprintTransferPair(
    labelTransferPair(judgment, { outflow: null, inflow: null }),
  );

/** The created transaction's kind: a card on either side makes it a card payment. */
function createdKind(
  leg: LegFacts | null,
  opposite: Account,
  own: Account,
  amount: number,
): FinancialTransactionKind {
  if (leg?.recordedKind) return leg.recordedKind;
  const kind: FinancialTransactionKind =
    own.kind === "credit_card" || opposite.kind === "credit_card"
      ? "credit_card_payment"
      : "account_transfer";
  return financialTransactionSettlementViolation({
    linked: false,
    kind,
    amount,
  })
    ? "account_transfer"
    : kind;
}

function legView(
  leg: LegFacts,
  opposite: Account,
  overlaps: TransferPairLeg["overlaps"],
): TransferPairLeg {
  return {
    key: leg.key,
    origin: leg.origin,
    accountId: parseShortcodeFor("financialAccount", leg.account.shortcode),
    accountName: leg.account.name,
    accountKind: leg.account.kind,
    owner: leg.account.owner
      ? {
          id: parseShortcodeFor("ledgerParty", leg.account.owner.id),
          name: leg.account.owner.name,
        }
      : null,
    transactionId: leg.transactionCode,
    charge: leg.charge,
    amount: leg.amount,
    date: leg.date,
    merchant: leg.merchant,
    description: leg.description,
    kind: createdKind(leg, opposite, leg.account, leg.amount),
    signals: {
      kind: leg.origin === "transaction" ? leg.recordedKind : leg.ruleKind,
      providerCategory: leg.providerCategory,
    },
    movementLabel: null,
    movement: "weak",
    refs: leg.refs,
    overlaps,
  };
}

export type Pool = {
  legs: LegFacts[];
  byCents: Map<number, LegFacts[]>;
};

export const poolOf = (legs: LegFacts[]): Pool => {
  const unique = uniqBy(legs, (leg) => leg.key);
  const byCents = new Map<number, LegFacts[]>();
  for (const leg of unique) {
    const key = cents(leg.amount);
    byCents.set(key, [...(byCents.get(key) ?? []), leg]);
  }
  return { legs: unique, byCents };
};

/** Equal and opposite, on another account, within the candidate window. */
export const candidatesOf = (pool: Pool, leg: LegFacts) =>
  (pool.byCents.get(-cents(leg.amount)) ?? [])
    .filter(
      (other) =>
        other.key !== leg.key &&
        other.account.id !== leg.account.id &&
        dayGap(other.date, leg.date) <= CANDIDATE_WINDOW_DAYS,
    )
    .sort((a, b) => a.key.localeCompare(b.key));

/** Other unresolved records of the same money on the leg's own account. */
function overlapsOf(pool: Pool, leg: LegFacts): TransferPairLeg["overlaps"] {
  const charges = (pool.byCents.get(cents(leg.amount)) ?? [])
    .filter(
      (other) =>
        other.key !== leg.key &&
        other.origin === "statement" &&
        other.account.id === leg.account.id &&
        dayGap(other.date, leg.date) <= OVERLAP_WINDOW_DAYS &&
        // One export speaks one vocabulary: two of its rows are two charges.
        ![...other.imports].some((id) => leg.imports.has(id)),
    )
    .map((other) => ({
      transactionId: null,
      charge: other.charge,
      date: other.date,
      description: other.description,
    }));
  return [...leg.transactionOverlaps, ...charges].sort((a, b) =>
    `${a.transactionId ?? ""}${a.charge ? chargeId(a.charge) : ""}`.localeCompare(
      `${b.transactionId ?? ""}${b.charge ? chargeId(b.charge) : ""}`,
    ),
  );
}

const competitorOf = (
  against: "outflow" | "inflow",
  anchor: LegFacts,
  other: LegFacts,
  opposite: Account,
) => {
  const view = legView(other, opposite, []);
  return {
    against,
    // Labels belong to a leg within its own pair, so a competitor here is weak.
    leg: {
      key: view.key,
      origin: view.origin,
      accountId: view.accountId,
      accountName: view.accountName,
      transactionId: view.transactionId,
      amount: view.amount,
      date: view.date,
      description: view.description,
      movement: "weak" as const,
    },
    dateGapDays: dayGap(anchor.date, other.date),
  };
};

export function buildPair(
  pool: Pool,
  outflow: LegFacts,
  inflow: LegFacts | { cash: Account },
): Pair {
  const realInflow = "cash" in inflow ? null : inflow;
  const inflowAccount = "cash" in inflow ? inflow.cash : inflow.account;
  const inflowLeg: TransferPairLeg = realInflow
    ? legView(realInflow, outflow.account, overlapsOf(pool, realInflow))
    : {
        key: `cash:${inflowAccount.shortcode}:${outflow.key}`,
        origin: "cash",
        accountId: parseShortcodeFor(
          "financialAccount",
          inflowAccount.shortcode,
        ),
        accountName: inflowAccount.name,
        accountKind: inflowAccount.kind,
        owner: inflowAccount.owner
          ? {
              id: parseShortcodeFor("ledgerParty", inflowAccount.owner.id),
              name: inflowAccount.owner.name,
            }
          : null,
        transactionId: null,
        charge: null,
        // The full bank amount: an ATM fee is entered on its own, never inferred.
        amount: -outflow.amount,
        date: outflow.date,
        merchant: null,
        description: null,
        kind: "account_transfer",
        signals: { kind: null, providerCategory: null },
        movementLabel: null,
        movement: "weak",
        refs: [],
        overlaps: [],
      };
  const outflowLeg = legView(outflow, inflowAccount, overlapsOf(pool, outflow));
  const competitors = [
    ...candidatesOf(pool, outflow)
      .filter((other) => other.key !== realInflow?.key)
      .map((other) => competitorOf("outflow", outflow, other, outflow.account)),
    ...(realInflow
      ? candidatesOf(pool, realInflow)
          .filter((other) => other.key !== outflow.key)
          .map((other) =>
            competitorOf("inflow", realInflow, other, realInflow.account),
          )
      : []),
  ];
  const date = outflow.date < inflowLeg.date ? outflow.date : inflowLeg.date;
  const judgment = derive({
    key: `${outflowLeg.key}~${inflowLeg.key}`,
    outflow: outflowLeg,
    inflow: inflowLeg,
    amount: Math.abs(outflow.amount),
    date,
    dateGapDays: dayGap(outflow.date, inflowLeg.date),
    move: "unowned",
    competitors,
    blockers: [],
    reasons: [],
    clean: false,
    apply: { available: false, reason: null },
  });
  return {
    judgment: transferPairJudgment.parse(judgment),
    outflowAccountId: outflow.account.id,
    inflowAccountId: inflowAccount.id,
  };
}

/** Rule revision stamped on every published pair; bump with any policy change. */
const TRANSFER_PAIR_REVISION = "2026-10-29.1";
