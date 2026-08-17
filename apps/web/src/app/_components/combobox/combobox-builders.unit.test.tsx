import {
  unsafeIngredientShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
  unsafeProjectShortcode,
  unsafeRecipeShortcode,
  unsafeTaskShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildProjectComboboxItem,
  buildRecipeComboboxItem,
  buildTaskComboboxItem,
  buildVendorNameComboboxItem,
  buildVendorShortcodeComboboxItem,
} from "./combobox-builders";

describe("entity picker value adapters", () => {
  it("keeps ING, LOC, and RCP assignments shortcode-valued", () => {
    const ingredientId = unsafeIngredientShortcode("ING-2ABC");
    const locationId = unsafeLocationShortcode("LOC-3ABC");
    const recipeId = unsafeRecipeShortcode("RCP-4ABC");

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
    const product = unsafeProductShortcode("PRD-5ABC");
    const project = unsafeProjectShortcode("PRJ-6ABC");
    const task = unsafeTaskShortcode("TSK-7ABC");
    const vendor = unsafeVendorShortcode("VEN-8ABC");

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
      buildVendorShortcodeComboboxItem({ id: vendor, name: "Acme" }),
    ).toMatchObject({ id: vendor, shortcode: vendor });
  });

  it("keeps the expense vendor adapter name-valued", () => {
    const vendor = unsafeVendorShortcode("VEN-9ABC");
    expect(
      buildVendorNameComboboxItem({ id: vendor, name: "Acme" }),
    ).toMatchObject({ id: "Acme", shortcode: vendor, name: "Acme" });
  });

  it("uses the project's custom mark in picker rows", () => {
    const item = buildProjectComboboxItem({
      id: unsafeProjectShortcode("PRJ-6ABC"),
      name: "Garage",
      icon: "🔧",
    });

    render(item.icon);
    expect(screen.getByText("🔧")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("product stock picker evidence", () => {
  const product = unsafeProductShortcode("PRD-5ABC");
  const base = {
    id: product,
    name: "Back Brace",
    manufacturer: "BraceAbility",
    category: "household",
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
