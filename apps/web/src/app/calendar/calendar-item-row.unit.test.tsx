import type { CalendarItem } from "@cubby/schemas/calendar";
import { testShortcode } from "@cubby/schemas/testing";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarItemPresentation } from "./calendar-item-row";

const eatingOutMeal: Extract<CalendarItem, { kind: "meal" }> = {
  kind: "meal",
  id: testShortcode("meal", "MEL-1111"),
  title: "Dinner with Andy and a deliberately long title",
  name: "Dinner with Andy and a deliberately long title",
  startDate: "2026-08-18",
  endDateExclusive: "2026-08-19",
  interaction: "move",
  sortOrder: null,
  mealType: "dinner",
  mealKind: "eating_out",
  recipeNames: [],
  coverImageUrl: null,
  cost: 0,
  calories: 0,
  nutritionPending: false,
};

const plannedExpense: Extract<CalendarItem, { kind: "expense" }> = {
  kind: "expense",
  id: testShortcode("expense", "EXP-1111"),
  title: "Freezer tray",
  startDate: "2026-08-18",
  endDateExclusive: "2026-08-19",
  interaction: "move",
  cost: 79,
  future: true,
  vendor: "Target",
  trade: "other",
  projectName: "Kitchen",
  productName: "Souper Cubes",
  coverImageUrl: "https://example.com/tray.png",
};

describe("CalendarItemPresentation", () => {
  it("keeps non-cooked meal kinds explicit in compact month rows", () => {
    render(<CalendarItemPresentation item={eatingOutMeal} variant="month" />);
    expect(screen.getByText("Eating out")).toBeInTheDocument();
  });

  it("shows the rich expense hierarchy and optional product cover", () => {
    render(<CalendarItemPresentation item={plannedExpense} variant="rich" />);
    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(
      screen.getByText("Target · Souper Cubes · Kitchen · Other"),
    ).toBeInTheDocument();
    expect(screen.getByRole("presentation")).toHaveClass("object-contain");
    expect(screen.getByText("$79")).toBeInTheDocument();
  });

  it("keeps the detail variant's thumbnail down to one line of text", () => {
    render(<CalendarItemPresentation item={plannedExpense} variant="detail" />);
    expect(
      screen.getByText("Target · Souper Cubes · Kitchen · Other"),
    ).toBeInTheDocument();
    expect(screen.getByRole("presentation").parentElement).toHaveStyle({
      width: "20px",
      height: "20px",
    });
  });

  it("moves the detail variant's money off the title line", () => {
    const { rerender } = render(
      <CalendarItemPresentation item={plannedExpense} variant="rich" />,
    );
    // Rich has room to price the name in place; a fortnight column does not,
    // so detail sends the number down to the mono data line.
    const titleLine = (element: HTMLElement) =>
      element.closest("div")?.textContent;
    expect(titleLine(screen.getByTitle(plannedExpense.title))).toContain("$79");

    rerender(
      <CalendarItemPresentation item={plannedExpense} variant="detail" />,
    );
    expect(titleLine(screen.getByTitle(plannedExpense.title))).not.toContain(
      "$79",
    );
    expect(screen.getByText("$79")).toBeInTheDocument();
  });

  it("drops the detail thumbnail entirely when the item has no cover", () => {
    render(<CalendarItemPresentation item={eatingOutMeal} variant="detail" />);
    // The leading kind icon already carries the entity; a placeholder square
    // would cost a quarter of a fortnight column for nothing.
    expect(screen.queryByRole("presentation")).not.toBeInTheDocument();
    expect(screen.getByText("Eating out")).toBeInTheDocument();
  });

  it("names task status and subject context without relying on color", () => {
    const task: Extract<CalendarItem, { kind: "task" }> = {
      kind: "task",
      id: testShortcode("task", "TSK-1111"),
      title: "Repair mixer",
      startDate: "2026-08-18",
      endDateExclusive: "2026-08-19",
      interaction: "move",
      dueDate: "2026-08-18",
      dueEndDate: null,
      status: "blocked",
      trade: "appliances",
      projectName: "Household",
      subjectProductName: "KitchenAid mixer",
      coverImageUrl: null,
    };
    render(<CalendarItemPresentation item={task} variant="rich" />);
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(
      screen.getByText("Household · KitchenAid mixer · Appliances & Furniture"),
    ).toBeInTheDocument();
  });
});
