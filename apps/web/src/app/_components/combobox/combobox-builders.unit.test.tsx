import type { SearchHit } from "@cubby/schemas/search";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { categorySummaryFixture } from "../../../../tooling/product-category-fixtures";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildProjectComboboxItem,
  buildRecipeComboboxItem,
  buildSearchHitComboboxItem,
  buildTaskComboboxItem,
  buildVendorComboboxItem,
} from "./combobox-builders";

function locationSearchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  const base: SearchHit = {
    id: "LOC-3ABC",
    entityType: "location",
    title: "Workshop drawer",
    subtitle: "Garage › Main area",
    typeHint: "drawer",
    imageUrl: "https://example.com/workshop-drawer.jpg",
    matchKind: "text",
    matchField: "title",
    matchReason: "Text match in title",
    matchTerms: ["workshop"],
  };
  return { ...base, ...overrides };
}

describe("entity picker value adapters", () => {
  it("keeps ING, LOC, and RCP assignments shortcode-valued", () => {
    const ingredientId = testShortcode("ingredient", "ING-2ABC");
    const locationId = testShortcode("location", "LOC-3ABC");
    const recipeId = testShortcode("recipe", "RCP-4ABC");

    expect(
      buildIngredientComboboxItem({
        id: ingredientId,
        name: "Scallion",
        aliases: ["green onion"],
      }),
    ).toMatchObject({
      id: ingredientId,
      shortcode: ingredientId,
      aliases: ["green onion"],
    });
    expect(
      buildLocationComboboxItem({
        id: locationId,
        name: "Pantry",
        type: "room",
      }),
    ).toMatchObject({ id: locationId, shortcode: locationId });
    expect(
      buildRecipeComboboxItem({
        id: recipeId,
        name: "Soup",
      }),
    ).toMatchObject({ id: recipeId, shortcode: recipeId });
  });

  it("keeps PRD, PRJ, TSK, and persisted VEN assignments shortcode-valued", () => {
    const product = testShortcode("product", "PRD-5ABC");
    const project = testShortcode("project", "PRJ-6ABC");
    const task = testShortcode("task", "TSK-7ABC");
    const vendor = testShortcode("vendor", "VEN-8ABC");

    expect(
      buildProductComboboxItem({
        id: product,
        name: "Drill",
        manufacturer: "Makita",
      }),
    ).toMatchObject({ id: product, shortcode: product, secondary: "Makita" });
    expect(
      buildProjectComboboxItem({
        id: project,
        name: "Garage",
        icon: "🔨",
      }),
    ).toMatchObject({ id: project, shortcode: project });
    expect(buildTaskComboboxItem({ id: task, name: "Paint" })).toMatchObject({
      id: task,
      shortcode: task,
    });
    expect(
      buildVendorComboboxItem(
        { id: vendor, name: "Acme" },
        { itemId: "shortcode" },
      ),
    ).toMatchObject({ id: vendor, shortcode: vendor });
  });

  it("keeps the expense vendor adapter name-valued", () => {
    const vendor = testShortcode("vendor", "VEN-9ABC");
    expect(
      buildVendorComboboxItem({ id: vendor, name: "Acme" }, { itemId: "name" }),
    ).toMatchObject({ id: "Acme", shortcode: vendor, name: "Acme" });
  });

  it("agrees on everything except the id between the two vendor item-id modes", () => {
    const vendor = testShortcode("vendor", "VEN-9ABC");
    const input = { id: vendor, name: "Acme", count: 3 };
    const byName = buildVendorComboboxItem(input, { itemId: "name" });
    const byShortcode = buildVendorComboboxItem(input, {
      itemId: "shortcode",
    });

    expect({ ...byName, id: undefined }).toEqual({
      ...byShortcode,
      id: undefined,
    });
    expect(byName.id).toBe("Acme");
    expect(byShortcode.id).toBe(vendor);
  });

  it("uses the project's custom mark in picker rows", () => {
    const item = buildProjectComboboxItem({
      id: testShortcode("project", "PRJ-6ABC"),
      name: "Garage",
      icon: "🔧",
    });

    render(item.icon);
    expect(screen.getByText("🔧")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("buildLocationComboboxItem tree presentation", () => {
  it("keeps the structured ancestry of a typed location search hit", () => {
    const item = buildSearchHitComboboxItem(
      locationSearchHit({
        locationPath: [
          { id: "LOC-1ABC", name: "Garage" },
          { id: "LOC-2ABC", name: "Workbench" },
        ],
      }),
      "location",
    );
    expect(item.name).toBe("Workshop drawer");
    expect(item.detail).toBe("Garage › Workbench");
    expect(item.presentation).toMatchObject({
      group: { id: "LOC-1ABC", label: "Garage" },
      depth: 2,
    });
  });
  it("groups under the root ancestor and sets depth to the path length", () => {
    const locationId = testShortcode("location", "LOC-9ABC");
    const rootId = testShortcode("location", "LOC-1ABC");
    const parentId = testShortcode("location", "LOC-2ABC");

    const item = buildLocationComboboxItem({
      id: locationId,
      name: "Drawer 2",
      type: "drawer",
      ancestors: [
        { id: rootId, name: "Garage" },
        { id: parentId, name: "Workbench" },
      ],
    });

    expect(item.presentation).toEqual({
      group: { id: rootId, label: "Garage", order: 0 },
      depth: 2,
    });
  });

  it("groups a root location under itself at depth 0", () => {
    const locationId = testShortcode("location", "LOC-1ABC");

    const item = buildLocationComboboxItem({
      id: locationId,
      name: "Garage",
      type: "room",
      ancestors: [],
    });

    expect(item.presentation).toEqual({
      group: { id: locationId, label: "Garage", order: 0 },
      depth: 0,
    });
  });

  it("carries no presentation when ancestors were never loaded", () => {
    const locationId = testShortcode("location", "LOC-1ABC");

    const item = buildLocationComboboxItem({
      id: locationId,
      name: "Freshly created shelf",
      type: "shelf",
    });

    expect(item.presentation).toBeUndefined();
  });
});

describe("location search picker imagery", () => {
  it.each([
    ["live", "drawer"],
    ["missing", null],
    ["retired", "quarter-crate"],
  ])("uses the full location tile for a %s type hint", (_label, typeHint) => {
    const item = buildSearchHitComboboxItem(
      locationSearchHit({ typeHint }),
      "location",
    );
    const { container } = render(item.icon);

    expect(container.firstElementChild).toHaveStyle({
      width: "52px",
      minHeight: "52px",
    });
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/workshop-drawer.jpg",
    );
  });

  it("keeps the full location tile when no image is available", () => {
    const item = buildSearchHitComboboxItem(
      locationSearchHit({ imageUrl: null, typeHint: null }),
      "location",
    );
    const { container } = render(item.icon);

    expect(container.firstElementChild).toHaveStyle({
      width: "52px",
      minHeight: "52px",
    });
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("product stock picker evidence", () => {
  const product = testShortcode("product", "PRD-5ABC");
  const base = {
    id: product,
    name: "Back Brace",
    manufacturer: "BraceAbility",
    category: categorySummaryFixture("household"),
    quantityLedger: {
      acquiredUnits: 1,
      exitedUnits: 0,
      expectedQuantity: 1,
      unknownAcquisitionLines: 0,
      unknownExitLines: 0,
      locationCount: 0,
    },
  } as const;

  it("leads with the missing quantity and its evidence", () => {
    expect(
      buildProductComboboxItem({ ...base, onHand: { state: "none" } }, "stock")
        .presentation,
    ).toEqual({
      group: { id: "needs-stock", label: "Needs stocking", order: 0 },
      status: { label: "Need 1", tone: "positive" },
      facts: ["0 on hand / 1 expected"],
    });
  });

  it("keeps the product cover photo beside quantity evidence", () => {
    const photographed = {
      ...base,
      coverImageUrl: "https://example.com/back-brace.png",
      onHand: { state: "none" } as const,
    };
    const item = buildProductComboboxItem(photographed, "stock");

    const { container } = render(item.icon);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      photographed.coverImageUrl,
    );
  });

  it("keeps a fully returned product visible below likely choices", () => {
    expect(
      buildProductComboboxItem(
        {
          ...base,
          quantityLedger: {
            ...base.quantityLedger,
            exitedUnits: 1,
            expectedQuantity: 0,
          },
          onHand: { state: "none" },
        },
        "stock",
      ).presentation,
    ).toEqual({
      group: { id: "other", label: "Other products", order: 2 },
      status: { label: "Returned" },
      facts: ["0 on hand / 0 expected"],
    });
  });

  it("does not manufacture a need from mixed or incomplete quantities", () => {
    const item = buildProductComboboxItem(
      {
        ...base,
        quantityLedger: {
          ...base.quantityLedger,
          unknownAcquisitionLines: 1,
        },
        onHand: { state: "mixed" },
      },
      "stock",
    );
    expect(item.presentation).toMatchObject({
      group: { id: "check" },
      status: { label: "Check quantity", tone: "warning" },
      facts: ["Mixed units on hand", "1 line without quantity"],
    });
  });

  it("derives mixed stock evidence from a full product detail result", () => {
    const item = buildProductComboboxItem(
      {
        ...base,
        onHandUnits: null,
        inventoryEntry: [
          { amount: { value: 1, unit: "each" } },
          { amount: { value: 2, unit: "box" } },
        ],
      },
      "stock",
    );

    expect(item.presentation).toMatchObject({
      group: { id: "check" },
      facts: ["Mixed units on hand"],
    });
  });
});
