import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecipeTotalsGap } from "~/lib/recipe-totals-gaps";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RecipeTotalsCoverageButton } from "./RecipeCostingCoverage";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(async () => {
  harness = createBrowserTestHarness();
  await harness.loadRouter();
});

afterEach(() => {
  harness.dispose();
});

const costGap: RecipeTotalsGap = {
  source: "ingredient",
  ingredientId: "ingredient-id",
  ingredientShortcode: "ING-TEST",
  name: "Broccoli",
  productId: null,
  productShortcode: null,
  lineUnit: "cup",
  lineKind: "volume",
  missing: { price: true, weight: false, nutrients: false, volume: false },
  kind: "no-product",
};

describe("RecipeTotalsCoverageButton", () => {
  it("opens live gaps from a controlled Problems deep link", () => {
    render(
      <RecipeTotalsCoverageButton
        gaps={[costGap]}
        currentRecipeId="recipe-id"
        currentRecipeShortcode="RCP-TEST"
        open
        onOpenChange={() => undefined}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("button", { name: /1 block totals/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("heading", {
        name: "Why aren't these totals complete?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Broccoli")).toBeInTheDocument();
  });

  it("clears a stale deep link only after live costing resolves empty", async () => {
    const onOpenChange = vi.fn();
    render(
      <RecipeTotalsCoverageButton
        gaps={[]}
        currentRecipeId="recipe-id"
        currentRecipeShortcode="RCP-TEST"
        open
        onOpenChange={onOpenChange}
        resolved
      />,
      { wrapper: harness.wrapper },
    );

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
