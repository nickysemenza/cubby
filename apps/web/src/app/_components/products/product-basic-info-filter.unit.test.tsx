import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProductBasicInfo } from "./product-basic-info";

const product: ProductWithFoodOut = productWithFoodOut.parse({
  id: testShortcode("product", "PRD-4K7M"),
  name: "Impact Driver",
  aliases: [],
  manufacturer: "Milwaukee",
  model: "2853-20",
  price: null,
  pricing: {
    derivedPrice: null,
    effectivePrice: null,
    source: "none",
    knownExpenseCount: 0,
    unknownExpenseCount: 0,
    knownUnitCount: 0,
    partial: false,
  },
  category: "tools",
  upc: null,
  fdc_id: null,
  primaryGtin: null,
  expectedQuantity: null,
  ingredient: {
    id: testShortcode("ingredient", "ING-2ABC"),
    name: "Driver bits",
    aliases: [],
    naKinds: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
  images: [],
  coverImageUrl: null,
  externalIds: [],
  food: null,
  tags: ["M18"],
  notes: null,
  usdaUnavailable: null,
  stockTracked: null,
  dataQuality: {
    status: "complete",
    facets: [],
    gaps: [],
    exceptions: [],
    relatedGaps: [],
    relatedExceptions: [],
  },
  unitMappings: [],
  inventoryEntry: [],
  servingAsLocations: [],
  componentCount: 0,
  recipeUsages: [],
  cookbooks: [],
  quantityLedger: {
    acquiredUnits: 0,
    exitedUnits: 0,
    expectedQuantity: 0,
    unknownAcquisitionLines: 0,
    unknownExitLines: 0,
    locationCount: 0,
  },
  onHandUnits: 0,
  quantityVariance: 0,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

describe("ProductBasicInfo filter links", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;

  beforeEach(() => {
    harness = createBrowserTestHarness();
  });

  afterEach(() => {
    harness.dispose();
  });

  it("preserves detail ordering and the printed ISBN label for a book barcode", () => {
    const book = productWithFoodOut.parse({
      ...product,
      primaryGtin: "09780306406157",
    });
    const { container } = render(
      <ProductBasicInfo product={book} onEdit={() => undefined} />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText("ISBN-13")).toBeVisible();
    expect(screen.getByText("9780306406157")).toBeVisible();
    expect(screen.queryByText("UPC", { exact: true })).not.toBeInTheDocument();
    expect(container).toHaveTextContent(
      /Name.*Shortcode.*Manufacturer.*Model.*Valuation price.*Category.*ISBN-13.*Ingredient.*Tags/,
    );
    expect(screen.queryByText("Stock Tracked")).not.toBeInTheDocument();
  });

  it("links read-only values and keeps editable/relationship cohorts separate", async () => {
    render(<ProductBasicInfo product={product} onEdit={() => undefined} />, {
      wrapper: harness.wrapper,
    });

    const manufacturer = await screen.findByRole("link", {
      name: "Show all products by Milwaukee",
    });
    expect(manufacturer).toHaveAttribute(
      "href",
      "/products?view=table&manufacturer=Milwaukee",
    );
    expect(
      screen.getByRole("link", {
        name: "Show all products matching model 2853-20",
      }),
    ).toHaveAttribute("href", "/products?view=table&model=2853-20");
    expect(
      screen.getByRole("link", { name: "Show all products tagged M18" }),
    ).toHaveAttribute("href", "/products?view=table&tags=M18");

    const categoryEdit = screen.getByRole("button", { name: "tools" });
    const categoryFilter = screen.getByRole("link", {
      name: "Show all products in tools",
    });
    expect(categoryEdit.contains(categoryFilter)).toBe(false);
    expect(categoryFilter).toHaveAttribute(
      "href",
      "/products?view=table&category=tools",
    );

    const ingredientDetail = screen.getByRole("link", { name: "Driver bits" });
    const ingredientFilter = screen.getByRole("link", {
      name: "Show all products for Driver bits",
    });
    expect(ingredientDetail).toHaveAttribute("href", "/ingredients/ING-2ABC");
    expect(ingredientFilter).toHaveAttribute(
      "href",
      "/products?view=table&ingredient=ING-2ABC",
    );
  });
});
