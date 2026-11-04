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
  it("prints the server's words and marks a missing total unavailable", () => {
    render(<ListTotalSummary totals={totals} labels={{ spend: "-$12.50" }} />);
    expect(screen.getByText("Spend").nextElementSibling).toHaveTextContent(
      "-$12.50",
    );
    expect(
      screen.getByText("Price range").nextElementSibling,
    ).toHaveTextContent("Unavailable");
  });

  it("reads as pending until a page answers, and unavailable only on failure", () => {
    const view = render(<ListTotalSummary totals={totals} />);
    expect(screen.getByText("Spend").nextElementSibling).toHaveTextContent("…");
    view.rerender(<ListTotalSummary totals={totals} failed />);
    expect(screen.getByText("Spend").nextElementSibling).toHaveTextContent(
      "Unavailable",
    );
  });
});
