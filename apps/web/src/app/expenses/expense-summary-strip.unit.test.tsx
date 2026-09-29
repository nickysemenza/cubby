import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { ExpenseSummaryStrip } from "./expense-summary-strip";

it("identifies project allocations separately from displayed ledger costs", () => {
  render(
    <ExpenseSummaryStrip
      basis="allocation"
      summary={{ actual: 20, committed: 0, credits: 5, net: 15, count: 2 }}
    />,
  );
  expect(screen.getByText("Allocated net")).toBeVisible();
  expect(screen.queryByText("Net")).not.toBeInTheDocument();
});

it("shows unavailable analytics instead of fabricated zero totals", () => {
  render(<ExpenseSummaryStrip />);
  expect(screen.getAllByText("Unavailable")).toHaveLength(6);
});
