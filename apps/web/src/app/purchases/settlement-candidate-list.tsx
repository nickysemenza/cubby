import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import {
  type PurchaseSettlementSuggestOut,
  tiedTopSettlementCandidates,
} from "@cubby/schemas/purchase";
import { useMemo } from "react";

import { formatCurrency } from "~/lib/utils";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";

export interface SettlementCandidateRow {
  transaction: FinancialTransactionOut;
  days: number;
  merchantMatches: boolean;
  exactAmount: boolean;
}

const percent = (probability: number) => `${Math.round(probability * 100)}%`;

/**
 * Tied top-rank candidates first, in the model's probability order once a
 * suggestion exists; the rest keep the server's deterministic order.
 */
function orderCandidates(
  candidates: readonly SettlementCandidateRow[],
  tied: readonly SettlementCandidateRow[],
  probabilities: ReadonlyMap<string, number>,
): SettlementCandidateRow[] {
  if (probabilities.size === 0) return [...candidates];
  const tiedSet = new Set(tied);
  const ordered = [...tied].sort(
    (a, b) =>
      (probabilities.get(b.transaction.id) ?? 0) -
      (probabilities.get(a.transaction.id) ?? 0),
  );
  return [...ordered, ...candidates.filter((c) => !tiedSet.has(c))];
}

/**
 * The reviewable candidate list. "Suggest a match" appears only while two or
 * more candidates tie at the deterministic top rank; the result highlights
 * and orders the tied candidates but selecting and allocating stay manual.
 */
export function SettlementCandidateList({
  candidates,
  selectedId,
  onSelect,
  suggestion,
  suggesting,
  onSuggest,
}: {
  candidates: readonly SettlementCandidateRow[];
  selectedId: string | null;
  onSelect: (candidate: SettlementCandidateRow) => void;
  suggestion: PurchaseSettlementSuggestOut | null;
  suggesting: boolean;
  onSuggest: () => void;
}) {
  const tied = useMemo(
    () => tiedTopSettlementCandidates(candidates),
    [candidates],
  );
  const ranked = suggestion?.status === "ranked" ? suggestion : null;
  const probabilities = useMemo(
    () =>
      new Map<string, number>(
        ranked?.ranked.map((entry) => [entry.transactionId, entry.probability]),
      ),
    [ranked],
  );
  const ordered = useMemo(
    () => orderCandidates(candidates, tied, probabilities),
    [candidates, tied, probabilities],
  );

  return (
    <>
      {tied.length >= 2 ? (
        <div className="space-y-1">
          <Button
            size="sm"
            variant="outline"
            disabled={suggesting}
            onClick={onSuggest}
          >
            {suggesting ? "Asking Jev…" : "Suggest a match"}
          </Button>
          {ranked ? (
            <Description size="xs">
              Suggestion only. Jev ordered the {tied.length} equally ranked
              charges; nothing is saved until you allocate.
              {ranked.selectedTransactionId === null
                ? " Jev found no clear match among them."
                : ""}
            </Description>
          ) : suggestion?.status === "unavailable" ? (
            <Description size="xs">
              Suggestion unavailable: {suggestion.error}
            </Description>
          ) : suggestion?.status === "not_ambiguous" ? (
            <Description size="xs">
              These charges are no longer tied, so there is nothing to suggest.
            </Description>
          ) : (
            <Description size="xs">
              {tied.length} charges rank equally. Jev can suggest which fits
              best; you still choose and allocate.
            </Description>
          )}
        </div>
      ) : null}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {ordered.map((candidate) => {
          const { transaction, days, merchantMatches } = candidate;
          const probability = probabilities.get(transaction.id);
          const suggested =
            ranked?.selectedTransactionId === transaction.id &&
            probability !== undefined;
          return (
            <button
              key={transaction.id}
              type="button"
              aria-pressed={selectedId === transaction.id}
              data-suggested={suggested ? "true" : undefined}
              className="flex w-full items-start justify-between gap-3 rounded-md border border-border p-3 text-left text-sm aria-pressed:border-primary aria-pressed:bg-primary/5 data-[suggested=true]:border-primary/60"
              onClick={() => onSelect(candidate)}
            >
              <span className="min-w-0">
                {suggested ? (
                  <Badge className="mb-1">
                    Suggested · {percent(probability)}
                  </Badge>
                ) : probability !== undefined ? (
                  <Badge variant="secondary" className="mb-1">
                    {percent(probability)}
                  </Badge>
                ) : null}
                <strong className="block truncate">
                  {transaction.merchant ?? transaction.displayName}
                </strong>
                <span className="block text-xs text-muted-foreground">
                  {transaction.kind === "refund" ? "Refund" : "Charge"}
                </span>
                {transaction.rawDescription &&
                transaction.rawDescription !== transaction.merchant ? (
                  <span className="block text-xs text-muted-foreground">
                    Statement: {transaction.rawDescription}
                  </span>
                ) : null}
                <span className="text-muted-foreground">
                  {transaction.postedDate ?? transaction.transactionDate} ·{" "}
                  {Math.round(days)} {Math.round(days) === 1 ? "day" : "days"}{" "}
                  apart
                  {merchantMatches
                    ? " · vendor name matches"
                    : " · vendor differs"}
                </span>
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                {formatCurrency(transaction.amount)}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
