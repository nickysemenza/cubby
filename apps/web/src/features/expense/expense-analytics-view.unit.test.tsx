import type { ExpenseAnalyticsOut } from "@cubby/schemas/project";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProjectExpenseAnalytics } from "./expense-analytics-view";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

const data: ExpenseAnalyticsOut = {
  summary: {
    actual: 12,
    committed: 0,
    credits: 0,
    net: 12,
    count: 1,
    actualCount: 1,
    plannedCount: 0,
    unpricedCount: 0,
  },
  byCostType: [],
  byTrade: [],
  tradeCostMatrix: [],
  monthly: [],
  cumulative: [],
  byProject: [],
  byVendor: [],
};

describe("expense analytics query lifecycle", () => {
  it("retries an initial failure and retains loaded analytics on refresh failure", async () => {
    let fail = true;
    const restore = overrideStartDispatch(async () => {
      if (fail) throw new Error("SQLSTATE 08006 synthetic expense analytics");
      return { ok: true, data };
    });
    try {
      render(<ProjectExpenseAnalytics projectId="PRJ-2222" />, {
        wrapper: harness.wrapper,
      });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "SQLSTATE 08006 synthetic expense analytics",
      );
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const content = await screen.findByText("Monthly Spend");
      fail = true;
      await act(async () => {
        await harness.queryClient.refetchQueries();
      });
      await screen.findByRole("alert");
      expect(screen.getByText("Monthly Spend")).toBe(content);
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(screen.getByText("Monthly Spend")).toBe(content);
    } finally {
      restore();
    }
  });
});
