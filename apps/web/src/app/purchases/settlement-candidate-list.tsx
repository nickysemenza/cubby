import type {
  purchaseSettlementCandidate,
  PurchaseSettlementSuggestOut,
} from "@cubby/schemas/purchase";
import { useMemo } from "react";

import { formatCurrency } from "~/lib/utils";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";

export type SettlementCandidate = typeof purchaseSettlementCandidate._output;

/**
 * The reviewable candidate list. Which candidates tie, what each says, the order a suggestion
 * puts them in and every badge are the server's; this only draws them. "Suggest a match" is
 * offered while the server reports a tie (`suggestHint`), and the result orders and badges the
 * tied candidates, while selecting and allocating stay manual.
 */
export function SettlementCandidateList({
  candidates,
  suggestHint,
  selectedId,
  onSelect,
  suggestion,
  suggesting,
  onSuggest,
}: {
  candidates: readonly SettlementCandidate[];
  suggestHint: string | null;
  selectedId: string | null;
  onSelect: (candidate: SettlementCandidate) => void;
  suggestion: PurchaseSettlementSuggestOut | null;
  suggesting: boolean;
  onSuggest: () => void;
}) {
  const ranked = suggestion?.status === "ranked" ? suggestion : null;
  const badges = useMemo(
    () =>
      new Map<string, string>(
        ranked?.ranked.map((entry) => [entry.transactionId, entry.badge]),
      ),
    [ranked],
  );
  const ordered = useMemo(() => {
    if (!ranked) return [...candidates];
    const position = new Map(
      ranked.displayOrder.map((id, index) => [id, index]),
    );
    return [...candidates].sort(
      (a, b) =>
        (position.get(a.transaction.id) ?? candidates.length) -
        (position.get(b.transaction.id) ?? candidates.length),
    );
  }, [candidates, ranked]);

  return (
    <>
      {suggestHint ? (
        <div className="space-y-1">
          <Button
            size="sm"
            variant="outline"
            disabled={suggesting}
            onClick={onSuggest}
          >
            {suggesting ? "Asking Jev…" : "Suggest a match"}
          </Button>
          <Description size="xs">{suggestion?.note ?? suggestHint}</Description>
        </div>
      ) : null}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {ordered.map((candidate) => {
          const { transaction } = candidate;
          const badge = badges.get(transaction.id);
          const suggested = ranked?.selectedTransactionId === transaction.id;
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
                {badge ? (
                  <Badge
                    variant={suggested ? "default" : "secondary"}
                    className="mb-1"
                  >
                    {badge}
                  </Badge>
                ) : null}
                <strong className="block truncate">{candidate.title}</strong>
                {candidate.lines.map((line) => (
                  <span
                    key={line}
                    className="block text-xs text-muted-foreground"
                  >
                    {line}
                  </span>
                ))}
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
