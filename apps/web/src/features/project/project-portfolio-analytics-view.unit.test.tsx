import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProjectPortfolioAnalyticsView } from "./project-portfolio-analytics-view";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

const data: ProjectPortfolioAnalyticsOut = {
  costVsEstimate: [],
  spendingByProject: [],
  monthlySpend: [],
  plannedVsActual: [],
  tradeActivity: [],
  taskHeatmap: [],
};

describe("portfolio analytics query lifecycle", () => {
  it("exposes initial failure diagnostics and retries instead of skeletons", () => {
    const onRetry = vi.fn();
    render(
      <ProjectPortfolioAnalyticsView
        data={undefined}
        isLoading={false}
        error={new Error("SQLSTATE 08006 synthetic initial analytics")}
        onRetry={onRetry}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SQLSTATE 08006 synthetic initial analytics",
    );
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("keeps real chart content mounted on refresh failure but removes it for a new scope", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ProjectPortfolioAnalyticsView
        data={data}
        isLoading={false}
        error={null}
        onRetry={onRetry}
      />,
      { wrapper: harness.wrapper },
    );
    const content = screen.getByText("No cost data.");
    rerender(
      <ProjectPortfolioAnalyticsView
        data={data}
        isLoading={false}
        error={new Error("synthetic refresh failure")}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("No cost data.")).toBe(content);
    rerender(
      <ProjectPortfolioAnalyticsView
        data={undefined}
        isLoading={true}
        error={null}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByText("No cost data.")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
});
