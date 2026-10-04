import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import {
  type purchaseSettlementCandidatesOut,
  tiedTopSettlementCandidates,
} from "@cubby/schemas/purchase";

import { proposeSettlementAllocations } from "./purchase-settlement-allocation";

type Review = typeof purchaseSettlementCandidatesOut._output;
type RankedCandidate = Omit<
  Review["candidates"][number],
  "title" | "lines" | "proposedAllocations"
>;

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
        ? "No unallocated vendor or exact amount match within 45 days. You can still add a transaction manually."
        : null,
    candidates: ranked.map((candidate) => {
      const { transaction, days, merchantMatches } = candidate;
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
      tied.length >= 2
        ? `${tied.length} charges rank equally. Jev can suggest which fits best; you still choose and allocate.`
        : null,
  };
}
