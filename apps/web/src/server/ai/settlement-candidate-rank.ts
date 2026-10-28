import { type FinancialTransactionRawOut as RawFinancialTransactionOut } from "@cubby/schemas/entity-contracts/financialTransaction";
/**
 * Declared review-only ranking over the complete bounded candidate set. Split
 * amounts, merchant aliases and different dates remain evidence for the model,
 * rather than semantic exclusions made by the deterministic sort. A ranking
 * never authorizes a settlement write.
 */
import { SETTLEMENT_CANDIDATE_LIMIT } from "@cubby/schemas/financial-transaction";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import {
  type PurchaseSettlementSuggestOut,
  type SettlementConflictKind,
} from "@cubby/schemas/purchase";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { formatCurrency } from "~/lib/number-format";
import type { DecisionPort } from "~/server/ai/decision-model";
import { type AiSelectionSpec } from "~/server/ai/policy/decision-choice";
import { SETTLEMENT_CANDIDATE_RANK_FEATURE } from "~/server/ai/policy/features";
import { type AiSelectionUsage, runAiSelection } from "~/server/ai/selection";

/** One deterministic candidate row, as `listPurchaseSettlementCandidates`
 * ranks it. */
export interface SettlementRank {
  transactionId: string;
  days: number;
  exactAmount: boolean;
  merchantMatches: boolean;
  conflicts: readonly SettlementConflictKind[];
}

export interface SettlementSubject {
  vendorName: string | null;
  date: string | null;
  statedTotal: number | null;
  orderId: string | null;
}

interface TiedCandidate {
  id: string;
  transaction: RawFinancialTransactionOut;
  conflicts: readonly SettlementConflictKind[];
}

const money = formatCurrency;

export function renderSettlementSubject(subject: SettlementSubject): string {
  return [
    "Vendor order awaiting a matching card or bank statement transaction.",
    `Vendor: ${subject.vendorName ?? "unknown"}`,
    `Order date: ${subject.date ?? "unknown"}`,
    `Stated total: ${subject.statedTotal === null ? "unknown" : money(subject.statedTotal)}`,
    `Order id: ${subject.orderId ?? "unknown"}`,
  ].join("\n");
}

export const settlementSelectionSpec: AiSelectionSpec<TiedCandidate> = {
  feature: SETTLEMENT_CANDIDATE_RANK_FEATURE,
  rules:
    "Choose the statement transaction most likely to be payment evidence for this vendor order. Compare literal amounts, residual money after accepted allocations, dates, account and merchant evidence. A line marked with an account conflict paid from another member's account or one the order's payment evidence does not name: prefer none over it. Split payments and processor names can differ permanently; amount or date equality alone is not identity proof. Preserve accepted allocations; never select by confidence alone. Use none when no listed transaction is supported. This is a review proposal, never write authority.",
  idOf: (candidate) => candidate.id,
  renderLine: ({ transaction, conflicts }) =>
    [
      `${transaction.kind} ${money(transaction.amount)}`,
      `posted ${transaction.postedDate ?? "pending"}`,
      `transacted ${transaction.transactionDate}`,
      `merchant "${transaction.merchant ?? transaction.displayName}"`,
      `account "${transaction.accountName ?? "unknown"}"`,
      `accepted allocations: ${transaction.allocations?.map((allocation) => `${allocation.purchaseId} ${money(allocation.amount)}`).join(", ") || "none"}`,
      ...(conflicts.length > 0
        ? [
            `account conflict: ${conflicts.join(", ")} (cannot settle this order without a member's acknowledgement)`,
          ]
        : []),
    ].join(" | "),
  maxCandidates: SETTLEMENT_CANDIDATE_LIMIT,
};

/**
 * Pure read plus AI usage accounting. A list with fewer than two candidates
 * costs no model call and supplies no automatic write authority.
 */
export async function suggestSettlementMatch(args: {
  subject: SettlementSubject;
  ranks: readonly SettlementRank[];
  loadTransaction: (id: string) => Promise<RawFinancialTransactionOut>;
  openUsage: () => Promise<AiSelectionUsage>;
  decisionPort?: DecisionPort;
}): Promise<PurchaseSettlementSuggestOut> {
  const tied = args.ranks.slice(0, SETTLEMENT_CANDIDATE_LIMIT);
  if (tied.length < 2)
    return {
      status: "not_ambiguous",
      note: "Fewer than two candidates remain; a sole candidate still requires evidence review.",
    };

  const candidates: TiedCandidate[] = [];
  for (const { transactionId, conflicts } of tied) {
    candidates.push({
      id: transactionId,
      transaction: await args.loadTransaction(transactionId),
      conflicts,
    });
  }

  try {
    const outcome = await runAiSelection(settlementSelectionSpec, {
      subject: renderSettlementSubject(args.subject),
      candidates,
      usage: await args.openUsage(),
      decisionPort: args.decisionPort,
    });
    const selectedTransactionId = outcome.selected
      ? financialTransactionShortcode.parse(outcome.selected.id)
      : null;
    const ranked = outcome.distribution.map(({ candidate, probability }) => {
      const transactionId = financialTransactionShortcode.parse(candidate.id);
      const percent = `${Math.round(probability * 100)}%`;
      return {
        transactionId,
        probability,
        badge:
          transactionId === selectedTransactionId
            ? `Suggested · ${percent}`
            : percent,
      };
    });
    // Missing model probabilities retain the server's deterministic order.
    const rankedIds = new Set<string>(
      ranked.map((entry) => entry.transactionId),
    );
    const tiedIds = new Set<string>(
      tied.map(({ transactionId }) => transactionId),
    );
    const displayOrder = [
      ...ranked.map((entry) => entry.transactionId),
      ...tied
        .filter(({ transactionId }) => !rankedIds.has(transactionId))
        .map(({ transactionId }) =>
          financialTransactionShortcode.parse(transactionId),
        ),
      ...args.ranks
        .filter(({ transactionId }) => !tiedIds.has(transactionId))
        .map(({ transactionId }) =>
          financialTransactionShortcode.parse(transactionId),
        ),
    ];
    return {
      status: "ranked",
      advisory: true,
      selectedTransactionId,
      ranked,
      displayOrder,
      note:
        `Suggestion only. The decision model ordered ${tied.length} candidate transactions; nothing is saved until you allocate.` +
        (selectedTransactionId === null
          ? " The decision model found no clear match among them."
          : ""),
    };
  } catch (error) {
    const message = scrubErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
    return {
      status: "unavailable",
      error: message,
      note: `Suggestion unavailable: ${message}`,
    };
  }
}
