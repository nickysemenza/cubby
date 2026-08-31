import type { ProductCookbookRefOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProductCookbook } from "./product-cookbook";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

const cookbook = (
  id: string,
  name: string,
  recipeCount: number,
): ProductCookbookRefOut => ({
  id: testShortcode("cookbook", id),
  name,
  recipeCount,
});

const renderCookbooks = (cookbooks: ProductCookbookRefOut[]) =>
  render(<ProductCookbook cookbooks={cookbooks} />, {
    wrapper: harness.wrapper,
  });

describe("ProductCookbook", () => {
  it("renders no association for an empty list", () => {
    const { container } = renderCookbooks([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one Cookbook and its recipe count", () => {
    renderCookbooks([cookbook("CKB-2345", "Everyday Cooking", 42)]);
    expect(screen.getByText("Everyday Cooking")).toBeVisible();
    expect(screen.getByText("42 recipes")).toBeVisible();
  });

  it("renders every Cookbook association", () => {
    renderCookbooks([
      cookbook("CKB-2345", "Everyday Cooking", 42),
      cookbook("CKB-2346", "Weekend Baking", 18),
    ]);
    expect(screen.getByText("Everyday Cooking")).toBeVisible();
    expect(screen.getByText("Weekend Baking")).toBeVisible();
  });
});
