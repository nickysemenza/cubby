import {
  shoppingListContribution,
  shoppingListItem,
} from "@cubby/schemas/meal";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ShoppingCard } from "./shopping-card";
import { buildShoppingRows } from "./shopping-model";

describe("ShoppingCard", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;

  beforeEach(() => {
    harness = createBrowserTestHarness();
  });

  afterEach(() => {
    harness.dispose();
  });

  it("keeps long item names readable while retaining the check target", () => {
    const row = buildShoppingRows(
      [
        shoppingListItem.parse({
          ingredientId: testShortcode("ingredient", "ING-CARD"),
          name: "A particularly long ingredient name for a small phone screen",
          basisUnit: "g",
          needValue: 1250,
          haveValue: 250,
          shortfall: 1000,
          status: "short",
          estimatedCost: null,
          usuallyOnHand: false,
          covered: false,
          availabilitySource: "inventory",
          quantityIssues: [],
          membership: "buy",
          perMeal: [
            shoppingListContribution.parse({
              mealId: testShortcode("meal", "MEL-CARD"),
              mealName: "Dinner",
              date: "2026-06-15",
              recipeId: testShortcode("recipe", "RCP-CARD"),
              recipeName: "Dinner recipe",
              scale: 1,
              needValue: 1250,
              amount: { value: 1250, unit: "g" },
              lineIndex: 0,
              via: [],
            }),
          ],
        }),
      ],
      new Set(),
    )[0]!;

    const onToggleCheck = vi.fn();
    render(<ShoppingCard row={row} onToggleCheck={onToggleCheck} />, {
      wrapper: harness.wrapper,
    });

    const link = screen.getByRole("link", {
      name: /particularly long ingredient/,
    });
    const checkbox = screen.getByRole("checkbox", {
      name: /particularly long ingredient/,
    });
    expect(link).toBeVisible();
    expect(checkbox).toBeVisible();
    fireEvent.click(checkbox);
    expect(onToggleCheck).toHaveBeenCalledOnce();
    fireEvent.click(link);
    expect(onToggleCheck).toHaveBeenCalledOnce();
    expect(screen.getByText("2.2 lb")).toBeVisible();
  });
});
