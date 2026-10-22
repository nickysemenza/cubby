import {
  shoppingListContribution,
  shoppingListItem,
} from "@cubby/schemas/meal";
import { render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { buildShoppingRows } from "./shopping-model";
import { ShoppingTable } from "./shopping-table";

const items = [
  shoppingListItem.parse({
    ingredientId: "ING-4K7M",
    name: "Synthetic lentils",
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
        mealId: "MEL-4K7M",
        mealName: "Synthetic dinner",
        date: "2026-06-15",
        recipeId: "RCP-4K7M",
        recipeName: "Synthetic stew",
        scale: 1,
        needValue: 1250,
        amount: { value: 1250, unit: "g" },
        lineIndex: 0,
        via: [],
      }),
    ],
  }),
];
const excluded: ReadonlySet<string> = new Set();
function ShoppingFixture() {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <ShoppingTable
      rows={buildShoppingRows(items, checked)}
      excluded={excluded}
      onToggleCheck={(key) =>
        setChecked((current) => (current.has(key) ? new Set() : new Set([key])))
      }
    />
  );
}
let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => harness.dispose());

it.each([1440, 402])(
  "keeps shopping checks and meal evidence usable at width %s",
  async (width) => {
    await page.viewport(width, 900);
    render(<ShoppingFixture />, { wrapper: harness.wrapper });
    const check = await screen.findByRole("checkbox", {
      name: "Check Synthetic lentils",
    });
    await userEvent.click(check);
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Check Synthetic lentils" }),
      ).toBeChecked(),
    );
    if (width >= 768)
      await userEvent.click(
        screen.getByRole("button", { name: "Expand Synthetic lentils" }),
      );
    else
      await userEvent.click(
        screen.getByRole("button", { name: /Synthetic lentils/ }),
      );
    const detail = await screen.findByRole("table", {
      name: "Meals needing Synthetic lentils",
    });
    expect(
      within(detail).getByRole("link", { name: "Synthetic stew" }),
    ).toHaveAttribute("href", "/recipes/RCP-4K7M");
    expect(
      within(detail).getByRole("link", { name: /Synthetic dinner/ }),
    ).toHaveAttribute("href", "/meals/MEL-4K7M");
    const search = screen.getByRole("textbox", { name: "Search ingredients" });
    await userEvent.fill(search, "unmatched");
    expect(await screen.findByText("Nothing matched")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(
      await screen.findByRole("checkbox", { name: "Check Synthetic lentils" }),
    ).toBeChecked();
  },
);
