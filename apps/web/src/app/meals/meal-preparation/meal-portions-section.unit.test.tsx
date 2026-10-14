import type {
  EntityReportOut,
  ReportBlock,
} from "@cubby/schemas/entity-report";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { MealPortionsSection } from "./meal-portions-section";

const mealToday = testShortcode("meal", "MEL-4K7M");

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: () => void;
let answer: EntityReportOut;

beforeEach(() => {
  harness = createBrowserTestHarness();
  restoreDispatch = overrideStartDispatch(async (operation) => {
    if (operation === "entityReport.get") return { ok: true, data: answer };
    throw new Error(`Unexpected operation: ${operation}`);
  });
});

afterEach(() => {
  restoreDispatch();
  harness.dispose();
});

const recipesBlock: ReportBlock = {
  kind: "records",
  title: "Recipes",
  empty: "",
  rows: [
    {
      entity: "recipe",
      id: "RCP-4K7M",
      title: "Pasta",
      subtitle: "×1",
      trailing: null,
    },
  ],
};

describe("MealPortionsSection", () => {
  it("draws the server's Portions ledgers and leaves the Recipes block to the recipe rows", async () => {
    answer = {
      blocks: [
        recipesBlock,
        {
          kind: "records",
          presentation: "ledger",
          title: "Portions · Pasta",
          empty: "No one has a portion of Pasta yet.",
          footer: "500 g made · 200 g assigned · 300 g unassigned",
          rows: [
            {
              entity: null,
              id: null,
              title: "Member A",
              subtitle: "1 serving · 200 g · 40% of batch",
              trailing: null,
              state: { kind: "not_reached", label: "Planned" },
            },
          ],
        },
      ],
    };
    render(<MealPortionsSection mealId={mealToday} />, {
      wrapper: harness.wrapper,
    });

    expect(await screen.findByText("Member A")).toBeVisible();
    expect(screen.getByText(/1 serving/)).toBeVisible();
    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(screen.getByText(/500 g made/)).toBeVisible();
    expect(screen.queryByText("Recipes")).not.toBeInTheDocument();
  });

  it("offers leftovers when no recipe has portions yet", async () => {
    answer = { blocks: [{ ...recipesBlock, rows: [] }] };
    const onAdd = vi.fn();
    render(
      <MealPortionsSection mealId={mealToday} onAddPreparedPortion={onAdd} />,
      { wrapper: harness.wrapper },
    );

    expect(await screen.findByText("No recipe portions yet")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add leftovers" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
