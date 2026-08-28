import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { meal } from "~/app/meals/meal.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { HomeAsOfWindow } from "./home-as-of-window";
import { type TodayMealsOperations, TodayMeals } from "./MealsCard";

const AS_OF: HomeAsOfWindow = {
  meals: { from: "2026-08-26", to: "2026-09-01" },
  spend: {
    months: [],
    filters: {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      future: false,
    },
  },
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("TodayMeals", () => {
  it("offers a thumb-sized retry when its real operation adapter fails", async () => {
    const requests: string[] = [];
    const operations = {
      upcomingSummary: meal.upcomingSummary.withTransport(async () => {
        requests.push("upcoming-summary");
        throw new Error("unavailable");
      }),
    } satisfies TodayMealsOperations;

    render(<TodayMeals asOf={AS_OF} operations={operations} />, {
      wrapper: harness.routerWrapper,
    });

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("min-h-11");

    fireEvent.click(retry);
    await waitFor(() => expect(requests).toHaveLength(2));
  });
});
