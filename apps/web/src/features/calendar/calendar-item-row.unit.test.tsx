import type { CalendarItem } from "@cubby/schemas/calendar";
import { buildNutrition, withMacros } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  EntityDisplayImagesProvider,
  entityDisplayImageKey,
} from "~/entity/entity-media/entity-display-images";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CalendarItemPresentation } from "./calendar-item-row";
import {
  plantingCalendarSourceFixture,
  mealCalendarSourceFixture,
  taskCalendarSourceFixture,
  expenseCalendarSourceFixture,
} from "./calendar-source.fixtures";

const eatingOutMeal: Extract<CalendarItem, { kind: "meal" }> = {
  kind: "meal",
  id: testShortcode("meal", "MEL-1111"),
  title: "Dinner with Andy and a deliberately long title",
  name: "Dinner with Andy and a deliberately long title",
  startDate: "2026-08-18",
  endDateExclusive: "2026-08-19",
  interaction: "move",
  sortOrder: null,
  source: mealCalendarSourceFixture({
    id: testShortcode("meal", "MEL-1111"),
    date: "2026-08-18",
    name: "Dinner with Andy and a deliberately long title",
    mealType: "dinner",
    mealKind: "eating_out",
  }),
  mealTotals: withMacros({
    cost: { status: "unavailable", reason: "empty" },
    nutrition: buildNutrition(() => ({
      status: "unavailable",
      reason: "empty",
    })),
  }),
};

const plantingMilestone: Extract<CalendarItem, { kind: "planting" }> = {
  kind: "planting",
  source: plantingCalendarSourceFixture(testShortcode("planting", "PLT-3B2C")),
  id: testShortcode("planting", "PLT-3B2C"),
  milestone: "sowed",
  title: "Tomato · Brandywine",
  locationName: "Raised bed 2",
  plannedWindow: "Late spring",
  startDate: "2026-08-18",
  endDateExclusive: "2026-08-19",
  interaction: "read-only",
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
  source: expenseCalendarSourceFixture(
    testShortcode("expense", "EXP-1111"),
    "other",
    "Target",
    [
      {
        id: testShortcode("image", "IMG-4K7M"),
        url: "https://example.com/tray.png",
      },
    ],
  ),
  projectName: "Kitchen",
  spendingContext: { projectNames: ["Kitchen"], parties: [] },
  productName: "Souper Cubes",
};

describe("CalendarItemPresentation", () => {
  it("shows canonical images in compact spans and day-sheet rows without a legacy cover", () => {
    const harness = createBrowserTestHarness();
    const ref = {
      entityKind: plantingMilestone.kind,
      entityId: plantingMilestone.id,
    };
    const seeded = {
      [entityDisplayImageKey(ref)]: {
        url: "https://images.example/calendar-plant.jpg",
      },
    };
    const content = (variant: "month" | "detail" | "rich") => (
      <EntityDisplayImagesProvider refs={[ref]} seeded={seeded}>
        <CalendarItemPresentation item={plantingMilestone} variant={variant} />
      </EntityDisplayImagesProvider>
    );
    const view = render(content("month"), { wrapper: harness.wrapper });
    try {
      for (const variant of ["month", "detail", "rich"] as const) {
        view.rerender(content(variant));
        expect(screen.getByRole("presentation")).toHaveAttribute(
          "src",
          "https://images.example/calendar-plant.jpg",
        );
        expect(screen.getByText(plantingMilestone.title)).toBeInTheDocument();
      }
    } finally {
      view.unmount();
      harness.dispose();
    }
  });

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
    expect(screen.getByText("$79.00")).toBeInTheDocument();
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
    expect(titleLine(screen.getByTitle(plannedExpense.title))).toContain(
      "$79.00",
    );

    rerender(
      <CalendarItemPresentation item={plannedExpense} variant="detail" />,
    );
    expect(titleLine(screen.getByTitle(plannedExpense.title))).not.toContain(
      "$79.00",
    );
    expect(screen.getByText("$79.00")).toBeInTheDocument();
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
      due: { start: "2026-08-18", end: null },
      status: "blocked",
      source: taskCalendarSourceFixture(
        testShortcode("task", "TSK-1111"),
        "appliances",
      ),
      projectName: "Household",
      assignedProjectName: "Household",
      subjectProductName: "KitchenAid mixer",
    };
    render(<CalendarItemPresentation item={task} variant="rich" />);
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(
      screen.getByText("Household · KitchenAid mixer · Appliances & Furniture"),
    ).toBeInTheDocument();
  });

  it("names a planting's milestone, planned window, and location", () => {
    render(
      <CalendarItemPresentation item={plantingMilestone} variant="rich" />,
    );
    expect(
      screen.getByText("Sowed · Late spring · Raised bed 2"),
    ).toBeInTheDocument();
    expect(screen.getByText("Tomato · Brandywine")).toBeInTheDocument();
  });
});
