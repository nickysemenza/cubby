import type {
  KitMembershipOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { product as productOperations } from "~/app/products/product.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ProductKitComponentsOperations,
  ProductKitComponents,
} from "./product-kit-components";

const KIT_ID = testShortcode("product", "PRD-KT23");
const DRILL_ID = testShortcode("product", "PRD-DR23");
const COMBO_ID = testShortcode("product", "PRD-CMB2");

/**
 * One component row. `onHandUnits` defaults to stocked so the existing cases
 * keep asserting what they were written to assert; the stock cases below pass
 * it explicitly.
 */
const component = (
  over: Partial<ProductComponentOut> & { productName: string },
): ProductComponentOut => ({
  productId: testShortcode("product", "PRD-CMP2"),
  manufacturer: "Milwaukee",
  quantity: 1,
  price: null,
  coverImageUrl: null,
  onHandUnits: 1,
  attachedAt: new Date("2026-01-01"),
  ...over,
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function kitOperations(
  components: ProductComponentOut[],
  membership: KitMembershipOut[],
): ProductKitComponentsOperations {
  return {
    // The production descriptors keep their schemas and cache metadata. These
    // are the two remote reads a browser test cannot perform locally.
    components: productOperations.components.withTransport(
      async () => components,
    ),
    kitMembership: productOperations.kitMembership.withTransport(
      async () => membership,
    ),
    search: productOperations.search,
    attachComponents: productOperations.attachComponents,
    detachComponents: productOperations.detachComponents,
  };
}

function renderWith(
  components: ProductComponentOut[],
  membership: KitMembershipOut[] = [],
) {
  return render(
    <ProductKitComponents
      productId={KIT_ID}
      operations={kitOperations(components, membership)}
    />,
    { wrapper: harness.wrapper },
  );
}

describe("ProductKitComponents", () => {
  it("renders a kit with several components, each with its quantity", async () => {
    renderWith([
      {
        productId: DRILL_ID,
        productName: "Bare Drill",
        manufacturer: "Milwaukee",
        quantity: 1,
        price: 89,
        coverImageUrl: "https://example.com/drill.png",
        onHandUnits: 1,
        attachedAt: new Date("2026-01-01"),
      },
      {
        productId: testShortcode("product", "PRD-BATT"),
        productName: "Battery Pack",
        manufacturer: "Milwaukee",
        quantity: 2,
        price: null,
        coverImageUrl: null,
        onHandUnits: 2,
        attachedAt: new Date("2026-01-01"),
      },
    ]);

    expect(
      await screen.findByRole("link", { name: "Bare Drill" }),
    ).toHaveAttribute("href", `/products/${DRILL_ID}`);
    expect(screen.getByRole("link", { name: "Battery Pack" })).toBeVisible();
    expect(screen.getByText("×1")).toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Image" })).toHaveAttribute(
      "src",
      "https://example.com/drill.png",
    );
    expect(screen.queryByText("Not a kit")).toBeNull();
    // No membership rows: this product isn't listed inside any other kit.
    expect(
      screen.queryByText("Kits this product is listed inside."),
    ).toBeNull();
  });

  it("shows the empty state when the product has no components", async () => {
    renderWith([]);

    expect(await screen.findByText("Not a kit")).toBeVisible();
  });

  it("shows the kits a product is listed inside, when it's part of one", async () => {
    renderWith(
      [],
      [
        {
          parentProductId: COMBO_ID,
          parentProductName: "18V Combo Kit",
          manufacturer: "Milwaukee",
          quantity: 2,
          coverImageUrl: null,
          attachedAt: new Date("2026-01-01"),
          price: 249,
          expenseCount: 1,
          purchase: null,
        },
      ],
    );

    expect(
      await screen.findByText("Kits this product is listed inside."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "18V Combo Kit" })).toHaveAttribute(
      "href",
      `/products/${COMBO_ID}`,
    );
    expect(screen.getByText("×2")).toBeInTheDocument();
  });

  /**
   * The three states a component's shelf can be in, and the one asymmetry that
   * matters: `0` is a real answer (that part is unaccounted for) while `—` means
   * the count is unanswerable because the entries carry incompatible units.
   * Collapsing the two would hide exactly the gap this column exists to show.
   *
   * Every row is priced so the only `—` on screen is the one under test.
   */
  it("renders each component's on-hand units, dashing only unanswerable ones", async () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-STKD"),
        productName: "Stocked Part",
        price: 10,
        onHandUnits: 2,
      }),
      component({
        productId: testShortcode("product", "PRD-GNE2"),
        productName: "Unaccounted Part",
        price: 11,
        onHandUnits: 0,
      }),
      component({
        productId: testShortcode("product", "PRD-MXD2"),
        productName: "Mixed Unit Part",
        price: 12,
        onHandUnits: null,
      }),
    ]);

    await screen.findByRole("link", { name: "Stocked Part" });
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(1);
  });

  it("reports a fully-stocked kit as stocked by its components", async () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-NST2"),
        productName: "Nightstand",
        quantity: 2,
        onHandUnits: 2,
      }),
    ]);

    expect(await screen.findByText("Stocked as its components")).toBeVisible();
  });

  it("counts the stocked parts when a kit is only partly accounted for", async () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-BRDG"),
        productName: "Bridge",
        onHandUnits: 1,
      }),
      component({
        productId: testShortcode("product", "PRD-BULB"),
        productName: "Bulbs",
        quantity: 3,
        onHandUnits: 0,
      }),
    ]);

    expect(await screen.findByText("1 of 2 components stocked")).toBeVisible();
    expect(screen.queryByText("Stocked as its components")).toBeNull();
  });

  /**
   * A kit none of whose parts are on a shelf has nothing reassuring to say, and
   * a "0 of 2" chip would read as a defect badge on a kit that was simply sold
   * or consumed whole. The existing layout is already the right answer.
   */
  it("stays silent when no component is stocked", async () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-DRY2"),
        productName: "Dust Bags",
        onHandUnits: 0,
      }),
    ]);

    await screen.findByRole("link", { name: "Dust Bags" });
    expect(screen.queryByText("Stocked as its components")).toBeNull();
    expect(screen.queryByText(/components stocked/)).toBeNull();
  });

  /**
   * The membership table lists the KITS this product sits inside. Their own
   * stock is a different question with a different answer, so the column is off
   * — `KitMembershipOut` has no on-hand field to render in the first place.
   */
  it("never shows an on-hand column on the memberships table", async () => {
    renderWith(
      [],
      [
        {
          parentProductId: COMBO_ID,
          parentProductName: "18V Combo Kit",
          manufacturer: "Milwaukee",
          quantity: 2,
          coverImageUrl: null,
          attachedAt: new Date("2026-01-01"),
          price: 249,
          expenseCount: 1,
          purchase: null,
        },
      ],
    );

    await screen.findByRole("link", { name: "18V Combo Kit" });
    expect(
      within(
        screen.getByRole("table", { name: "Kit memberships" }),
      ).queryByText("On hand"),
    ).toBeNull();
  });
});
