import { foodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usdaFood } from "~/entities/usda.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type USDAFoodListOperations,
  USDAFoodList,
  withUSDAListIdentity,
} from "./usdafoodlist";

const food = foodSummaryWithLinkedProducts.parse({
  fdc_id: 12345,
  description: "Example food",
  foodInfo: { data_type: "branded_food", description: "Example food" },
  legacyFoodInfo: null,
  brandedFoodInfo: null,
  nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
  portionInfoRaw: [],
  inferredUnitMappings: [],
  linkedProducts: [],
});

const operations: USDAFoodListOperations = {
  list: usdaFood.list.withTransport(async () => ({
    items: [food],
    meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
  })),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("USDAFoodList", () => {
  it("adapts the external FDC identity to the shared list contract", () => {
    expect(withUSDAListIdentity(food)).toMatchObject({
      id: "12345",
      name: "Example food",
    });
  });

  it("renders USDA identity and scan-ready classification through the real list", async () => {
    render(<USDAFoodList operations={operations} />, {
      wrapper: harness.wrapper,
    });

    expect(await screen.findByText("Example food")).toBeVisible();
    expect(
      screen.getByRole("table", { name: "USDA Foods Table" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "12345" })).toHaveAttribute(
      "href",
      "/usda/12345",
    );
    // The declared `Type` filter now also renders as a band chip, so the
    // column is found by role rather than by text.
    expect(screen.getByRole("columnheader", { name: /Type/ })).toBeVisible();
  });
});
