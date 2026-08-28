import type { CalendarDaySummary } from "@cubby/schemas/calendar";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WeekSummaryGrid } from "./calendar-week-summary";

const summary: CalendarDaySummary = {
  actualSpend: 1299,
  plannedSpend: 4200,
  calories: 1875.4,
  nutritionPending: true,
  taskCount: 3,
  expenseCount: 1,
  mealCount: 2,
  projectCount: 0,
};

describe("WeekSummaryGrid", () => {
  it("renders seven aligned server summaries, including explicit zero days", () => {
    const days = Array.from(
      { length: 7 },
      (_, offset) => `2026-08-${String(16 + offset).padStart(2, "0")}`,
    );
    render(
      <WeekSummaryGrid
        days={days}
        summaries={{ "2026-08-18": summary }}
        today="2026-08-18"
        onDayClick={() => undefined}
      />,
    );

    const headers = screen.getAllByRole("button");
    expect(headers).toHaveLength(7);
    const todayHeader = screen.getByRole("button", {
      name: "Open Tuesday, August 18",
    });
    const sundayHeader = screen.getByRole("button", {
      name: "Open Sunday, August 16",
    });
    expect(todayHeader).toHaveAttribute("data-today", "true");
    expect(within(todayHeader).getByText("3")).toBeInTheDocument();
    expect(within(todayHeader).getByText("1,875+")).toBeInTheDocument();
    expect(within(todayHeader).getByText("$1,299")).toBeInTheDocument();
    expect(within(todayHeader).getByText("$4,200")).toBeInTheDocument();
    expect(within(sundayHeader).getAllByText("0")).toHaveLength(2);
    expect(within(sundayHeader).getAllByText("$0")).toHaveLength(2);
  });

  it("opens the canonical day represented by a header", () => {
    const onDayClick = vi.fn();
    render(
      <WeekSummaryGrid
        days={["2026-08-16"]}
        summaries={{}}
        today="2026-08-18"
        onDayClick={onDayClick}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Sunday, August 16" }),
    );
    expect(onDayClick).toHaveBeenCalledWith("2026-08-16");
  });
});
