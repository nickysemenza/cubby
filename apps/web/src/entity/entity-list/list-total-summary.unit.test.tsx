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
  it("distinguishes deferred totals from unavailable totals and shows raw failures", () => {
    const { rerender } = render(
      <ListTotalSummary totals={totals} state={{ state: "loading" }} />,
    );
    expect(screen.getAllByText("Loading…")).toHaveLength(3);
    rerender(
      <ListTotalSummary
        totals={totals}
        state={{ state: "error", error: "Synthetic summary failure" }}
      />,
    );
    expect(screen.getByText("Synthetic summary failure")).toBeVisible();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("prints the server's words and marks a missing total unavailable", () => {
    render(<ListTotalSummary totals={totals} labels={{ spend: "-$12.50" }} />);
    expect(screen.getByText("Spend").nextElementSibling).toHaveTextContent(
      "-$12.50",
    );
    expect(
      screen.getByText("Price range").nextElementSibling,
    ).toHaveTextContent("Unavailable");
  });
});
