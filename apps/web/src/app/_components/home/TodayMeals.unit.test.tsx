import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn(),
  refetch: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => {
    mocks.useQuery(options);
    return {
      data: undefined,
      isError: true,
      isLoading: false,
      refetch: mocks.refetch,
    };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children?: ReactNode }) => (
    <a {...props} href="/meals">
      {children}
    </a>
  ),
}));
vi.mock("~/app/meals/meal.functions", () => ({
  meal: { upcomingSummary: { queryOptions: mocks.queryOptions } },
}));

import { TodayMeals } from "./MealsCard";

beforeEach(() => {
  mocks.queryOptions.mockReset();
  mocks.queryOptions.mockReturnValue({ queryKey: ["upcoming-meals"] });
  mocks.refetch.mockReset();
  mocks.useQuery.mockReset();
});

describe("TodayMeals", () => {
  it("offers a thumb-sized retry when its query fails", () => {
    render(
      <TodayMeals
        asOf={{
          meals: { from: "2026-08-26", to: "2026-09-01" },
          spend: {
            months: [],
            filters: {
              dateFrom: "2026-08-01",
              dateTo: "2026-08-31",
              future: false,
            },
          },
        }}
      />,
    );

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("min-h-11");

    fireEvent.click(retry);
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
