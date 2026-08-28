import type { KitMembershipOut } from "@cubby/schemas/product-components";
import type { ProductPurchaseOut } from "@cubby/schemas/purchase";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { product as productOperations } from "~/app/products/product.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ProductPurchasesOperations,
  ProductPurchases,
} from "./product-purchases";

const COMBO_ID = testShortcode("product", "PRD-COMB");

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function purchaseOperations(
  purchases: ProductPurchaseOut[],
  membership: KitMembershipOut[] = [],
): ProductPurchasesOperations {
  return {
    purchases: productOperations.purchases.withTransport(async () => purchases),
    kitMembership: productOperations.kitMembership.withTransport(
      async () => membership,
    ),
  };
}

function renderWith(
  purchases: ProductPurchaseOut[],
  membership: KitMembershipOut[] = [],
) {
  return render(
    <ProductPurchases
      productId="PRD-BATT"
      operations={purchaseOperations(purchases, membership)}
    />,
    { wrapper: harness.wrapper },
  );
}

const membershipEntry: KitMembershipOut = {
  parentProductId: COMBO_ID,
  parentProductName: "18V Combo Kit",
  manufacturer: "Milwaukee",
  quantity: 2,
  coverImageUrl: null,
  attachedAt: new Date("2026-01-01"),
  price: 249,
  expenseCount: 1,
  purchase: {
    purchaseId: testShortcode("purchase", "PUR-2345"),
    displayLabel: null,
    vendorName: "Home Depot",
    date: "2026-07-29",
    orderId: "#11325",
  },
};

describe("ProductPurchases empty states", () => {
  it("shows the ordinary empty state for a plain product with no purchases", async () => {
    renderWith([]);

    expect(await screen.findByText("No purchases recorded")).toBeVisible();
    expect(
      screen.getByText(
        "No expense on this product names an order, and no order has been linked to it directly. Record the spend on an expense, or attach it from a purchase's Products section when the order was never itemized.",
      ),
    ).toBeInTheDocument();
  });

  it("points at the kit's purchase instead of inviting a direct attach, for a kit component", async () => {
    renderWith([], [membershipEntry]);

    expect(await screen.findByText("No purchases of its own")).toBeVisible();
    expect(screen.getByRole("link", { name: /18V Combo Kit/ })).toHaveAttribute(
      "href",
      `/products/${COMBO_ID}`,
    );
    // The now-wrong "attach this product" advice must be gone.
    expect(
      screen.queryByText(
        "Attach this product from a purchase's Products section to record which order it came from.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /#11325/ })).toHaveAttribute(
      "href",
      "/purchases/PUR-2345",
    );
  });

  it("omits the purchase link when the kit itself has never been purchased", async () => {
    renderWith([], [{ ...membershipEntry, purchase: null }]);

    expect(await screen.findByText("No purchases of its own")).toBeVisible();
    expect(screen.queryByRole("link", { name: "#11325" })).toBeNull();
  });

  it("renders the purchase list instead of an empty state when purchases exist", async () => {
    renderWith([
      {
        purchaseId: testShortcode("purchase", "PUR-9999"),
        displayLabel: null,
        vendorName: "Amazon",
        date: "2026-08-01",
        orderId: "#999",
        source: "link",
        linkAttachedAt: new Date("2026-08-01"),
      },
    ]);

    expect(await screen.findByRole("link", { name: "#999" })).toBeVisible();
    expect(screen.queryByText("No purchases recorded")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No purchases of its own"),
    ).not.toBeInTheDocument();
  });

  it("badges only the explicitly-linked row, not the expense-derived one", async () => {
    renderWith([
      {
        purchaseId: testShortcode("purchase", "PUR-LINK"),
        displayLabel: null,
        vendorName: "Ferguson",
        date: "2026-08-02",
        orderId: "#link",
        source: "link",
        linkAttachedAt: new Date("2026-08-02"),
      },
      {
        purchaseId: testShortcode("purchase", "PUR-EXPN"),
        displayLabel: null,
        vendorName: "Home Depot",
        date: "2026-08-01",
        orderId: "#expense",
        source: "expense",
        linkAttachedAt: null,
      },
    ]);

    expect(await screen.findByRole("link", { name: "#link" })).toBeVisible();
    expect(screen.getByRole("link", { name: "#expense" })).toBeInTheDocument();
    expect(screen.getAllByText("Linked")).toHaveLength(1);
  });

  // NOT tested here, deliberately: that the blank-header `link` column disables
  // sorting. A sortable column renders its header as a button labelled by the
  // header text, so a blank one is a button with no accessible name — Axe rates
  // it `serious`. This tier cannot see it: the `RTable` mock above renders only
  // `tbody`, so an assertion about header buttons passes whether or not the bug
  // is present (verified by reintroducing it). `tests/e2e/accessibility.smoke`
  // is the tier that can fail, and it is what caught this.
});
