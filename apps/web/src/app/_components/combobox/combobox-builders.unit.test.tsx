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
