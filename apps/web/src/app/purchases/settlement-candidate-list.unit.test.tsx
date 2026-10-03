import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import type { PurchaseSettlementSuggestOut } from "@cubby/schemas/purchase";
import { fireEvent, render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import {
  SettlementCandidateList,
  type SettlementCandidateRow,
} from "./settlement-candidate-list";

const code = (suffix: string) =>
  financialTransactionShortcode.parse(`FTX-${suffix}`);
const row = (
  id: string,
  merchant: string,
  tier: { exactAmount: boolean; merchantMatches: boolean },
): SettlementCandidateRow => ({
  transaction: fromPartial<FinancialTransactionOut>({
    id,
    merchant,
    displayName: merchant,
    kind: "purchase",
    amount: 42.5,
    postedDate: "2026-03-04",
    transactionDate: "2026-03-03",
    rawDescription: null,
  }),
  days: 2,
  ...tier,
});

const top = { exactAmount: true, merchantMatches: true };
const tied = [
  row(code("4K7M"), "Example Hardware North", top),
  row(code("5N8P"), "Example Hardware South", top),
];
const lower = row(code("6Q9R"), "Example Garden", {
  exactAmount: false,
  merchantMatches: true,
});

function renderList(
  candidates: SettlementCandidateRow[],
  suggestion: PurchaseSettlementSuggestOut | null = null,
  onSuggest = vi.fn(),
) {
  render(
    <SettlementCandidateList
      candidates={candidates}
      selectedId={null}
      onSelect={vi.fn()}
      suggestion={suggestion}
      suggesting={false}
      onSuggest={onSuggest}
    />,
  );
  return onSuggest;
}

const merchantOrder = () =>
  screen.getAllByRole("button", { pressed: false }).map((b) => b.textContent);

describe("SettlementCandidateList", () => {
  it("offers Suggest a match only when two candidates tie at the top rank", () => {
    const onSuggest = renderList([...tied, lower]);
    fireEvent.click(screen.getByRole("button", { name: "Suggest a match" }));
    expect(onSuggest).toHaveBeenCalledOnce();
  });

  it("hides the action when the top rank has a single candidate", () => {
    renderList([row(code("7S2T"), "Example Solo", top), lower]);
    expect(
      screen.queryByRole("button", { name: "Suggest a match" }),
    ).toBeNull();
  });

  it("highlights the pick and orders tied candidates by probability", () => {
    renderList([...tied, lower], {
      status: "ranked",
      advisory: true,
      selectedTransactionId: code("5N8P"),
      ranked: [
        { transactionId: code("5N8P"), probability: 0.72 },
        { transactionId: code("4K7M"), probability: 0.18 },
      ],
    });
    expect(screen.getByText("Suggested · 72%")).toBeInTheDocument();
    expect(screen.getByText(/Suggestion only/)).toBeInTheDocument();
    const order = merchantOrder();
    expect(order[0]).toContain("Example Hardware South");
    expect(order[1]).toContain("Example Hardware North");
    expect(order[2]).toContain("Example Garden");
  });

  it("shows the raw diagnostic when the suggestion is unavailable", () => {
    renderList(tied, { status: "unavailable", error: "gateway timeout" });
    expect(screen.getByText(/gateway timeout/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Suggest a match" }),
    ).toBeEnabled();
  });
});
