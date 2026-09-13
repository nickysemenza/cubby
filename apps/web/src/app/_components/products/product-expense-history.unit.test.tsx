import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import type { KitMembershipOut } from "@cubby/schemas/product-components";
import type { ExpenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expense } from "~/app/expenses/expense.functions";
import { product as productOperations } from "~/app/products/product.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ProductExpenseHistoryOperations,
  ProductExpenseHistory,
} from "./product-expense-history";

const COMBO_ID = testShortcode("product", "PRD-COMB");
const product: ProductWithFoodOut = productWithFoodOut.parse({
  id: testShortcode("product", "PRD-BATT"),
  name: "Battery Pack",
  aliases: [],
  tags: [],
  primaryGtin: null,
  fdc_id: null,
  growsIngredientId: null,
  manufacturer: "Milwaukee",
  model: null,
  notes: null,
  expectedQuantity: null,
  category: "tools",
  images: [],
  coverImageUrl: null,
  externalIds: [],
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
  ingredient: null,
  unitMappings: [],
  inventoryEntry: [],
  servingAsLocations: [],
  componentCount: 0,
  food: null,
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

const membershipEntry: KitMembershipOut = {
  parentProductId: COMBO_ID,
  parentProductName: "18V Combo Kit",
  manufacturer: "Milwaukee",
  quantity: 2,
  coverImageUrl: null,
  attachedAt: new Date("2026-01-01"),
  price: 249,
  expenseCount: 1,
  purchase: null,
};

const expenseEntry: ExpenseOut = {
  id: testShortcode("expense", "EXP-2345"),
  name: "Battery pack",
  cost: 49,
  date: "2026-07-31",
  lineKind: "principal",
  lineBasis: "item_line",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  productId: testShortcode("product", "PRD-BATT"),
  productQuantity: 1,
  vendor: "Home Depot",
  orderId: "#123",
  orderUrl: null,
  purchaseId: testShortcode("purchase", "PUR-2345"),
  purchaseDate: "2026-07-29",
  purchaseDisplayLabel: null,
  vendorId: testShortcode("vendor", "VEN-2345"),
  vendorLogo: null,
  projectName: null,
  productName: "Battery Pack",
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  createdAt: new Date("2026-07-31T12:00:00Z"),
  updatedAt: new Date("2026-07-31T12:00:00Z"),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function historyOperations(
  expenses: ExpenseOut[],
  membership: KitMembershipOut[],
): ProductExpenseHistoryOperations {
  return {
    // The descriptors still parse output and publish their production cache
    // metadata; the test only replaces their browser transport.
    expenses: expense.chartData.withTransport(async () => expenses),
    kitMembership: productOperations.kitMembership.withTransport(
      async () => membership,
    ),
  };
}

function renderHistory(
  expenses: ExpenseOut[],
  membership: KitMembershipOut[] = [],
) {
  return render(
    <ProductExpenseHistory
      product={product}
      operations={historyOperations(expenses, membership)}
    />,
    { wrapper: harness.wrapper },
  );
}

describe("ProductExpenseHistory empty states", () => {
  it("shows the ordinary empty state for a plain product with no expenses", async () => {
    renderHistory([]);

    expect(await screen.findByText("No expenses linked")).toBeVisible();
    expect(
      screen.getByText("Link one to track this product's cost basis."),
    ).toBeVisible();
    expect(screen.queryByText("No expenses of its own")).toBeNull();
  });

  it("names the kit and explains the derived share for a component", async () => {
    renderHistory([], [membershipEntry]);

    expect(await screen.findByText("No expenses of its own")).toBeVisible();
    expect(screen.getByRole("link", { name: /18V Combo Kit/ })).toHaveAttribute(
      "href",
      `/products/${COMBO_ID}`,
    );
    expect(screen.getByText(/derived share/)).toBeVisible();
    expect(screen.getByText("See the kit's expenses →")).toBeVisible();
    expect(screen.queryByText("No expenses linked")).toBeNull();
  });

  it("does not offer a ledger link when the kit itself has no expenses", async () => {
    renderHistory([], [{ ...membershipEntry, expenseCount: 0 }]);

    expect(await screen.findByText("No expenses of its own")).toBeVisible();
    expect(screen.queryByText("See the kit's expenses →")).toBeNull();
  });

  it("renders the real expense workbench when expenses exist", async () => {
    renderHistory([expenseEntry]);

    expect(
      await screen.findByLabelText("Battery Pack expense history"),
    ).toBeVisible();
    expect(screen.queryByText("No expenses linked")).toBeNull();
    expect(screen.queryByText("No expenses of its own")).toBeNull();
  });
});
