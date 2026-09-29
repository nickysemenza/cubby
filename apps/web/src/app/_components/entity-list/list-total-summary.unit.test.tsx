import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ListTotalSummary } from "./list-total-summary";

const totals = [
  { id: "spend", label: "Spend", keys: ["expenseTotal"], format: "currency" },
  { id: "count", label: "Expenses", keys: ["expenseCount"], format: "integer" },
  {
    id: "range",
    label: "Price range",
    keys: ["priceLow", "priceHigh"],
    format: "currencyRange",
  },
] as const;

describe("ListTotalSummary", () => {
  it("shows full-filter zero and signed totals, including a complete range", () => {
    render(
      <ListTotalSummary
        totals={totals}
        sums={{
          expenseTotal: -12.5,
          expenseCount: 0,
          priceLow: 0,
          priceHigh: 42,
        }}
      />,
    );
    expect(screen.getByText("Spend").nextElementSibling).toHaveTextContent(
      "-$12.50",
    );
    expect(screen.getByText("Expenses").nextElementSibling).toHaveTextContent(
      "0",
    );
    expect(
      screen.getByText("Price range").nextElementSibling,
    ).toHaveTextContent("$0.00 – $42.00");
  });

  it("does not present loaded rows or incomplete server totals as a full-filter sum", () => {
    const { rerender } = render(
      <ListTotalSummary totals={totals} sums={undefined} />,
    );
    expect(screen.getByText("Spend").nextElementSibling).toHaveTextContent(
      "Unavailable",
    );
    rerender(<ListTotalSummary totals={totals} sums={{ priceLow: 10 }} />);
    expect(
      screen.getByText("Price range").nextElementSibling,
    ).toHaveTextContent("Unavailable");
  });
});
