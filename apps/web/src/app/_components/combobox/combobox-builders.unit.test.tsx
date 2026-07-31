import {
  unsafeIngredientId,
  unsafeLocationId,
  unsafeProductShortcode,
  unsafeProjectShortcode,
  unsafeRecipeId,
  unsafeTaskShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
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
  it("keeps UUID-backed ING, LOC, and RCP assignments while displaying shortcodes", () => {
    const ingredientId = unsafeIngredientId(
      "00000000-0000-4000-8000-000000000001",
    );
    const locationId = unsafeLocationId("00000000-0000-4000-8000-000000000002");
    const recipeId = unsafeRecipeId("00000000-0000-4000-8000-000000000003");

    expect(
      buildIngredientComboboxItem({
        id: ingredientId,
        shortcode: "ING-2ABC",
        name: "Scallion",
        aliases: ["green onion"],
      }),
    ).toMatchObject({
      id: ingredientId,
      shortcode: "ING-2ABC",
      aliases: ["green onion"],
    });
    expect(
      buildLocationComboboxItem({
        id: locationId,
        shortcode: "LOC-3ABC",
        name: "Pantry",
        type: "room",
      }),
    ).toMatchObject({ id: locationId, shortcode: "LOC-3ABC" });
    expect(
      buildRecipeComboboxItem({
        id: recipeId,
        shortcode: "RCP-4ABC",
        name: "Soup",
      }),
    ).toMatchObject({ id: recipeId, shortcode: "RCP-4ABC" });
  });

  it("keeps PRD, PRJ, TSK, and persisted VEN assignments shortcode-valued", () => {
    const product = unsafeProductShortcode("PRD-5ABC");
    const project = unsafeProjectShortcode("PRJ-6ABC");
    const task = unsafeTaskShortcode("TSK-7ABC");
    const vendor = unsafeVendorShortcode("VEN-8ABC");

    expect(
      buildProductComboboxItem({
        shortcode: product,
        name: "Drill",
        manufacturer: "Makita",
      }),
    ).toMatchObject({ id: product, shortcode: product, secondary: "Makita" });
    expect(
      buildProjectComboboxItem({ id: project, name: "Garage" }),
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
});
