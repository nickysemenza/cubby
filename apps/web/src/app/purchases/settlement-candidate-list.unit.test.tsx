import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import type { PurchaseSettlementSuggestOut } from "@cubby/schemas/purchase";
import { fireEvent, render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import {
  SettlementCandidateList,
  type SettlementCandidate,
} from "./settlement-candidate-list";

const code = (suffix: string) =>
  financialTransactionShortcode.parse(`FTX-${suffix}`);
const candidate = (id: string, merchant: string): SettlementCandidate => ({
  transaction: fromPartial<FinancialTransactionOut>({
    id,
    merchant,
    displayName: merchant,
    kind: "purchase",
    amount: 42.5,
  }),
  days: 2,
  exactAmount: true,
  merchantMatches: true,
  title: merchant,
  lines: ["Charge", "2026-03-04 · 2 days apart · vendor name matches"],
  proposedAllocations: [],
});

const north = candidate(code("4K7M"), "Example Hardware North");
const south = candidate(code("5N8P"), "Example Hardware South");
const garden = candidate(code("6Q9R"), "Example Garden");
const hint =
  "2 charges rank equally. Jev can suggest which fits best; you still choose and allocate.";

function renderList(
  candidates: SettlementCandidate[],
  options: {
    suggestHint?: string | null;
    suggestion?: PurchaseSettlementSuggestOut | null;
    onSuggest?: () => void;
  } = {},
) {
  const onSuggest = options.onSuggest ?? vi.fn();
  render(
    <SettlementCandidateList
      candidates={candidates}
      suggestHint={options.suggestHint ?? null}
      selectedId={null}
      onSelect={vi.fn()}
      suggestion={options.suggestion ?? null}
      suggesting={false}
      onSuggest={onSuggest}
    />,
  );
  return onSuggest;
}

const merchantOrder = () =>
  screen.getAllByRole("button", { pressed: false }).map((b) => b.textContent);

// The list draws the server's tie, wording, order and badges; it holds no
// ranking rule of its own.
describe("SettlementCandidateList", () => {
  it("offers Suggest a match exactly when the server reports a tie", () => {
    const onSuggest = renderList([north, south, garden], { suggestHint: hint });
    expect(screen.getByText(hint)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Suggest a match" }));
    expect(onSuggest).toHaveBeenCalledOnce();
  });

  it("hides the action when the server reports no tie", () => {
    renderList([north, garden]);
    expect(
      screen.queryByRole("button", { name: "Suggest a match" }),
    ).toBeNull();
  });

  it("shows the server's badges and display order, and says it is only a suggestion", () => {
    renderList([north, south, garden], {
      suggestHint: hint,
      suggestion: {
        status: "ranked",
        advisory: true,
        selectedTransactionId: code("5N8P"),
        ranked: [
          {
            transactionId: code("5N8P"),
            probability: 0.72,
            badge: "Suggested · 72%",
          },
          { transactionId: code("4K7M"), probability: 0.18, badge: "18%" },
        ],
        displayOrder: [code("5N8P"), code("4K7M"), code("6Q9R")],
        note: "Suggestion only. Jev ordered the 2 equally ranked charges; nothing is saved until you allocate.",
      },
    });
    expect(screen.getByText("Suggested · 72%")).toBeInTheDocument();
    expect(screen.getByText(/Suggestion only/)).toBeInTheDocument();
    const order = merchantOrder();
    expect(order[0]).toContain("Example Hardware South");
    expect(order[1]).toContain("Example Hardware North");
    expect(order[2]).toContain("Example Garden");
  });

  it("shows the raw diagnostic when the suggestion is unavailable", () => {
    renderList([north, south], {
      suggestHint: hint,
      suggestion: {
        status: "unavailable",
        error: "gateway timeout",
        note: "Suggestion unavailable: gateway timeout",
      },
    });
    expect(screen.getByText(/gateway timeout/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Suggest a match" }),
    ).toBeEnabled();
  });
});
