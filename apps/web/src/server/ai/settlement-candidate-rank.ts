/**
 * The bounded Jev tie-break for the Purchase settlement review. When the
 * deterministic candidate ranking ties two or more statement transactions at
 * its top tier, a person may ask Jev to order only those tied candidates.
 * The result is a suggestion: nothing here writes an allocation, and the
 * review's own allocate action remains the only write authority.
 */
import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import {
  type PurchaseSettlementSuggestOut,
  tiedTopSettlementCandidates,
} from "@cubby/schemas/purchase";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { formatCurrency } from "~/lib/utils";
import { SETTLEMENT_CANDIDATE_RANK_FEATURE } from "~/server/ai/features";
import type { JevPort } from "~/server/ai/jev";
import {
  type AiSelectionSpec,
  type AiSelectionUsage,
  runAiSelection,
} from "~/server/ai/selection";

/** One deterministic candidate row, as `listPurchaseSettlementCandidates`
 * ranks it. */
export interface SettlementRank {
  transactionId: string;
  days: number;
  exactAmount: boolean;
  merchantMatches: boolean;
}

export interface SettlementSubject {
  vendorName: string | null;
  date: string | null;
  statedTotal: number | null;
  orderId: string | null;
}

interface TiedCandidate {
  id: string;
  transaction: FinancialTransactionOut;
}

const money = formatCurrency;

function renderSubject(subject: SettlementSubject): string {
  return [
    "Vendor order awaiting a matching card or bank statement transaction.",
    `Vendor: ${subject.vendorName ?? "unknown"}`,
    `Order date: ${subject.date ?? "unknown"}`,
    `Stated total: ${subject.statedTotal === null ? "unknown" : money(subject.statedTotal)}`,
    `Order id: ${subject.orderId ?? "unknown"}`,
  ].join("\n");
}

const selectionSpec: AiSelectionSpec<TiedCandidate> = {
  feature: SETTLEMENT_CANDIDATE_RANK_FEATURE,
  rules:
    "Choose the statement transaction most likely to be the payment for this vendor order. Compare the amount to the stated total, the transaction date to the order date, and the merchant text to the vendor. Use none when no listed transaction fits.",
  idOf: (candidate) => candidate.id,
  renderLine: ({ transaction }) =>
    [
      `${transaction.kind} ${money(transaction.amount)}`,
      `posted ${transaction.postedDate ?? "pending"}`,
      `transacted ${transaction.transactionDate}`,
      `merchant "${transaction.merchant ?? transaction.displayName}"`,
      `account "${transaction.accountName ?? "unknown"}"`,
    ].join(" | "),
  // Only top-tier ties reach the model; ten is the repo's own candidate cap.
  maxCandidates: 10,
};

/**
 * Pure read plus AI usage accounting. `openUsage` is only called once a tie
 * exists, so an unambiguous list costs no model call and no run row.
 */
export async function suggestSettlementMatch(args: {
  subject: SettlementSubject;
  ranks: readonly SettlementRank[];
  loadTransaction: (id: string) => Promise<FinancialTransactionOut>;
  openUsage: () => Promise<AiSelectionUsage>;
  jev?: JevPort;
}): Promise<PurchaseSettlementSuggestOut> {
  const tied = tiedTopSettlementCandidates(args.ranks);
  if (tied.length < 2)
    return {
      status: "not_ambiguous",
      note: "These charges are no longer tied, so there is nothing to suggest.",
    };

  const candidates: TiedCandidate[] = [];
  for (const { transactionId } of tied) {
    candidates.push({
      id: transactionId,
      transaction: await args.loadTransaction(transactionId),
    });
  }

  try {
    const outcome = await runAiSelection(selectionSpec, {
      subject: renderSubject(args.subject),
      candidates,
      usage: await args.openUsage(),
      jev: args.jev,
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
    // Tied candidates by the model's probability, then the rest as the server listed them.
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
        `Suggestion only. Jev ordered the ${tied.length} equally ranked charges; nothing is saved until you allocate.` +
        (selectedTransactionId === null
          ? " Jev found no clear match among them."
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
