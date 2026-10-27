import type { RawFinancialTransactionOut } from "@cubby/schemas/financial-transaction-raw-read";
import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import {
  type purchaseSettlementCandidatesOut,
  type SettlementConflictKind,
  tiedTopSettlementCandidates,
} from "@cubby/schemas/purchase";

import { proposeSettlementAllocations } from "./purchase-settlement-allocation";

type PublicReview = typeof purchaseSettlementCandidatesOut._output;
type Review = Omit<PublicReview, "candidates"> & {
  candidates: (Omit<PublicReview["candidates"][number], "transaction"> & {
    transaction: RawFinancialTransactionOut;
  })[];
};
type RankedCandidate = Omit<
  Review["candidates"][number],
  "title" | "lines" | "proposedAllocations"
>;

const conflictLine = {
  party: "Account belongs to another member than this order's vendor account",
  tender: "Account is not one this order's payment evidence names",
} as const satisfies Record<SettlementConflictKind, string>;

const dayCount = (days: number) =>
  `${Math.round(days)} ${Math.round(days) === 1 ? "day" : "days"}`;

/**
 * The reviewable statement entries for one Purchase as every client shows
 * them: worded lines, the rows an allocation starts from, and which entries
 * tie at the top rank (so "Suggest a match" is offered). The ranking itself is
 * `listPurchaseSettlementCandidates`; nothing here selects or allocates.
 */
export function composeSettlementReview(
  purchase: {
    id: PurchaseShortcode;
    date: string | null;
    statedTotal: number | null;
  },
  ranked: readonly RankedCandidate[],
): Omit<Review, "advisory"> {
  const tied = tiedTopSettlementCandidates(ranked);
  return {
    message: !purchase.date
      ? "Add the order date to see likely statement activity."
      : ranked.length === 0
        ? "No spending transaction within 45 days. You can still add a transaction manually."
        : null,
    candidates: ranked.map((candidate) => {
      const { transaction, days, merchantMatches, nearAmount, conflicts } =
        candidate;
      return {
        ...candidate,
        title: transaction.merchant ?? transaction.displayName,
        lines: [
          transaction.kind === "refund" ? "Refund" : "Charge",
          ...(transaction.rawDescription &&
          transaction.rawDescription !== transaction.merchant
            ? [`Statement: ${transaction.rawDescription}`]
            : []),
          `${transaction.postedDate ?? transaction.transactionDate} · ${dayCount(days)} apart · ${
            merchantMatches ? "vendor name matches" : "vendor differs"
          }`,
          ...(nearAmount ? ["One cent off the stated total"] : []),
          ...conflicts.map((kind) => conflictLine[kind]),
        ],
        proposedAllocations: proposeSettlementAllocations(
          purchase.id,
          transaction,
          purchase,
        ),
      };
    }),
    tiedTransactionIds: tied.map(({ transaction }) => transaction.id),
    suggestHint:
      ranked.length >= 2
        ? `The decision model can compare all ${ranked.length} candidate transactions, including split and differently named payments; you still choose and allocate.`
        : null,
  };
}
