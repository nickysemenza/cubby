import type { RecipeOut } from "@cubby/schemas/recipe";
import { describe, expect, it, vi } from "vitest";
import {
  readKitchenProgress,
  recipeInstructionStepKey,
  recipeInstructionStepKeys,
  recipeKitchenProgressStorageKey,
  toggleKitchenStep,
  writeKitchenProgress,
} from "./recipe-kitchen-progress";

const recipe = (id: string): RecipeOut =>
  ({
    id,
    name: "Dinner",
    yield: null,
    servings: null,
    notes: null,
    images: [],
    sections: [
      {
        id: `${id}-first`,
        name: null,
        ingredients: [],
        instructions: [{ instruction: "Mix" }, { instruction: "Bake" }],
      },
    ],
  }) as unknown as RecipeOut;

describe("recipe kitchen progress", () => {
  it("keys completed steps by section and index, isolated by recipe shortcode", () => {
    expect(recipeInstructionStepKey("section-a", 2)).toBe("section-a:2");
    expect(recipeKitchenProgressStorageKey("RCP-ONE")).toBe(
      "cubby:recipe-kitchen:v1:RCP-ONE",
    );
    expect(recipeKitchenProgressStorageKey("RCP-ONE")).not.toBe(
      recipeKitchenProgressStorageKey("RCP-TWO"),
    );
  });

  it("restores only current recipe steps and drops stale keys", () => {
    const current = recipe("RCP-ONE");
    const valid = recipeInstructionStepKeys(current);
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify({
          version: 1,
          completedStepKeys: ["RCP-ONE-first:0", "removed-section:3"],
        }),
      ),
    };

    expect(
      readKitchenProgress("cubby:recipe-kitchen:v1:RCP-ONE", valid, storage),
    ).toEqual(new Set(["RCP-ONE-first:0"]));
  });

  it.each([
    ["not json"],
    [JSON.stringify({ version: 0, completedStepKeys: ["RCP-ONE-first:0"] })],
    [JSON.stringify({ version: 1, completedStepKeys: "RCP-ONE-first:0" })],
  ])("ignores malformed or older progress payloads", (payload) => {
    const storage = { getItem: vi.fn(() => payload) };
    expect(
      readKitchenProgress(
        "cubby:recipe-kitchen:v1:RCP-ONE",
        recipeInstructionStepKeys(recipe("RCP-ONE")),
        storage,
      ),
    ).toEqual(new Set());
  });

  it("toggles and writes the completed set only after the caller has hydrated", () => {
    const storage = { setItem: vi.fn() };
    const toggled = toggleKitchenStep(new Set(), "RCP-ONE-first:1");
    expect(toggleKitchenStep(toggled, "RCP-ONE-first:1")).toEqual(new Set());

    writeKitchenProgress("cubby:recipe-kitchen:v1:RCP-ONE", toggled, storage);
    expect(storage.setItem).toHaveBeenCalledWith(
      "cubby:recipe-kitchen:v1:RCP-ONE",
      JSON.stringify({ version: 1, completedStepKeys: ["RCP-ONE-first:1"] }),
    );
  });
});
