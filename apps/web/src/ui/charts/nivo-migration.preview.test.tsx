import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import {
  costRecipe,
  emptyIngredient,
  g,
  ingredientFromMappings,
  makeEntry,
} from "~/lib/recipe-costing.fixtures";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import RecipeCostTreemap from "~/ui/visualizations/recipe-cost-treemap";

import { NetworkChart } from "./network-chart";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => harness?.dispose());

// Nivo's default nodes are pointer-only; the shared renderer must retain
// keyboard selection and the distinction between stored and native bridges.
it("selects network nodes by keyboard and distinguishes built-in links", async () => {
  await page.viewport(402, 874);
  const select = vi.fn();
  const screen = render(
    <NetworkChart
      summary="Synthetic unit connections"
      data={{
        nodes: [
          {
            id: "g",
            label: "Grams",
            size: 12,
            color: "var(--chart-1)",
            onSelect: select,
          },
          { id: "kg", label: "Kilograms", size: 12, color: "var(--chart-1)" },
        ],
        links: [{ source: "g", target: "kg", native: true }],
      }}
    />,
  );
  const button = await screen.findByRole("button", { name: "Grams" });
  button.focus();
  fireEvent.keyDown(button, { key: "Enter" });
  expect(select).toHaveBeenCalledOnce();
  expect(
    screen.container.querySelector('line[stroke-dasharray="3 3"]'),
  ).not.toBeNull();
  expect(screen.container.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );
});

// The same ingredient can occur in several recipe rows. Tile identity must
// use the row, and an unknown price must never consume a priced tile's area.
it("keeps duplicate ingredient rows and excludes unknown prices from tile areas", async () => {
  await page.viewport(1440, 900);
  harness = createBrowserTestHarness();
  const rows = [
    { ...makeEntry("flour", "Synthetic flour", [g(10)]), id: "first-row" },
    { ...makeEntry("flour", "Synthetic flour", [g(10)]), id: "second-row" },
    makeEntry("spice", "Synthetic spice", [g(1)]),
  ];
  const costing = costRecipe(rows, {
    flour: ingredientFromMappings("flour", "Synthetic flour", [
      { a: g(100), b: { value: 2, unit: "dollar" } },
    ]),
    spice: emptyIngredient("spice", "Synthetic spice"),
  });
  const screen = render(
    <div style={{ width: 600 }}>
      <RecipeCostTreemap ingredients={costing.rows} totalCost={0.4} />
    </div>,
    { wrapper: harness.wrapper },
  );
  await waitFor(() =>
    expect(
      screen.container.querySelectorAll('svg rect[fill^="var(--chart-seq-"]'),
    ).toHaveLength(2),
  );
  fireEvent.click(screen.getByText("Ingredient costs and links"));
  expect(screen.getAllByRole("link", { name: "Synthetic flour" })).toHaveLength(
    2,
  );
  expect(screen.getByText("Unpriced")).toBeVisible();
});
