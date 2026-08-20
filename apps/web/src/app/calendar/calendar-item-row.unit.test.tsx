import type { CalendarItem } from "@cubby/schemas/calendar";
import {
  unsafeExpenseShortcode,
  unsafeMealShortcode,
  unsafeTaskShortcode,
} from "@cubby/schemas/identifiers";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalendarItemPresentation } from "./calendar-item-row";

const eatingOutMeal: Extract<CalendarItem, { kind: "meal" }> = {
  kind: "meal",
  id: unsafeMealShortcode("MEL-1111"),
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
  id: unsafeExpenseShortcode("EXP-1111"),
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

  it("names task status and subject context without relying on color", () => {
    const task: Extract<CalendarItem, { kind: "task" }> = {
      kind: "task",
      id: unsafeTaskShortcode("TSK-1111"),
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
