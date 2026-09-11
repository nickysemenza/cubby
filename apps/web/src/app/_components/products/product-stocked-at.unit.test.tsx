import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { product as productOperations } from "~/app/products/product.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ProductStockedAtOperations,
  ProductStockedAt,
  productStockedRows,
} from "./product-stocked-at";

const entry = (id: string, locationId: string) => ({
  id: testShortcode("inventory", id),
  amount: { value: 2, unit: "each" },
  valuation: 10,
  verifiedAt: null,
  placement: "stock" as const,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  location: {
    id: testShortcode("location", locationId),
    name: "shelf",
    aliases: [],
    tags: [],
    type: null,
    product: null,
    lastBulkInventory: null,
    aiDescription: null,
    images: [],
    valuation: null,
    displayImage: null,
    ancestors: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
});

const product: ProductWithFoodOut = productWithFoodOut.parse({
  id: testShortcode("product", "PRD-AAAA"),
  name: "Bora Clamp",
  aliases: [],
  tags: [],
  primaryGtin: null,
  fdc_id: null,
  manufacturer: "Bora",
  model: null,
  notes: null,
  expectedQuantity: null,
  category: "tools",
  images: [],
  coverImageUrl: null,
  externalIds: [],
  unitMappings: [],
  price: null,
  pricing: {
    effectivePrice: 26.26,
    derivedPrice: 26.26,
    source: "derived",
    knownExpenseCount: 0,
    unknownExpenseCount: 0,
    knownUnitCount: 0,
    partial: false,
  },
  inventoryEntry: [
    entry("INV-AAAA", "LOC-AAAA"),
    entry("INV-BBBB", "LOC-BBBB"),
  ],
  servingAsLocations: [],
  ingredient: null,
  food: null,
  recipeUsages: [],
  cookbooks: [],
  componentCount: 0,
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
  quantityLedger: {
    acquiredUnits: 0,
    exitedUnits: 0,
    expectedQuantity: 0,
    unknownAcquisitionLines: 0,
    unknownExitLines: 0,
    locationCount: 0,
  },
  onHandUnits: 4,
  quantityVariance: 0,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

const locationsOnlyProduct: ProductWithFoodOut = productWithFoodOut.parse({
  ...product,
  inventoryEntry: [],
  servingAsLocations: [
    {
      id: testShortcode("location", "LOC-CCCC"),
      name: "chrome wire shelf",
      type: null,
      displayImage: null,
      ancestors: [],
    },
  ],
});

const componentOperations: ProductStockedAtOperations = {
  components: productOperations.components.withTransport(async () => [
    {
      productId: testShortcode("product", "PRD-COMPONENT"),
      productName: "Clamp jaw",
      manufacturer: "Bora",
      quantity: 2,
      price: null,
      coverImageUrl: null,
      onHandUnits: 3,
      attachedAt: new Date("2026-01-01"),
    },
  ]),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function renderStockedAt(
  stockedProduct: ProductWithFoodOut,
  operations: ProductStockedAtOperations = componentOperations,
) {
  return render(
    <ProductStockedAt product={stockedProduct} operations={operations} />,
    { wrapper: harness.wrapper },
  );
}

describe("productStockedRows", () => {
  it("keeps stock entries actionable and represents a location identity at the effective price", () => {
    const stockRows = productStockedRows(product);
    const identityRows = productStockedRows(locationsOnlyProduct);
    const explicitIdentityRows = productStockedRows(
      productWithFoodOut.parse({
        ...locationsOnlyProduct,
        price: 40,
        pricing: {
          effectivePrice: 40,
          derivedPrice: 26.26,
          source: "explicit",
          knownExpenseCount: 0,
          unknownExpenseCount: 0,
          knownUnitCount: 0,
          partial: false,
        },
      }),
    );

    expect(stockRows).toHaveLength(2);
    expect(stockRows[0]).toMatchObject({ kind: "stock", id: "INV-AAAA" });
    expect(identityRows).toEqual([
      expect.objectContaining({
        kind: "identity",
        amount: { value: 1, unit: "each" },
        valuation: 26.26,
      }),
    ]);
    expect(explicitIdentityRows[0]).toMatchObject({ valuation: 40 });
  });
});

describe("ProductStockedAt", () => {
  it("renders the location breakdown and real embedded table", async () => {
    renderStockedAt(product);

    const breakdown = await screen.findByLabelText(
      "Bora Clamp location breakdown",
    );
    const inventory = await screen.findByLabelText("Bora Clamp inventory");
    expect(breakdown).toHaveTextContent("4 each");
    expect(inventory).toBeVisible();
    expect(within(breakdown).getAllByText("shelf")).toHaveLength(2);
    expect(within(inventory).getAllByText("stock")).toHaveLength(2);
  });

  it("renders the unstocked shelf state only when neither stock form exists", async () => {
    renderStockedAt(
      productWithFoodOut.parse({
        ...product,
        inventoryEntry: [],
        servingAsLocations: [],
      }),
    );

    expect(await screen.findByText("Not stocked anywhere")).toBeVisible();
  });

  it("keeps a location-identity row in the table and out of inventory actions", async () => {
    renderStockedAt(locationsOnlyProduct);

    const breakdown = await screen.findByLabelText(
      "Bora Clamp location breakdown",
    );
    const inventory = await screen.findByLabelText("Bora Clamp inventory");
    expect(within(breakdown).getByText("chrome wire shelf")).toBeVisible();
    expect(within(breakdown).getByText("is this location")).toBeVisible();
    expect(within(inventory).getByText("chrome wire shelf")).toBeVisible();
    const identityRow = within(inventory).getByRole("row", {
      name: /chrome wire shelf/,
    });
    fireEvent.click(
      within(identityRow).getByRole("button", { name: "Open menu" }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: /move|delete|mark as stock|mark installed/i,
      }),
    ).toBeNull();
  });

  it("uses the components operation when a decomposed kit has no direct stock", async () => {
    renderStockedAt(
      productWithFoodOut.parse({
        ...product,
        inventoryEntry: [],
        componentCount: 1,
      }),
    );

    expect(
      await screen.findByText("Not stocked under this name"),
    ).toBeVisible();
    expect(await screen.findByText("Clamp jaw")).toBeVisible();
    expect(screen.getByText("2×")).toBeVisible();
  });
});
