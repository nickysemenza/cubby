import { describe, expect, it } from "vitest";
import {
  detectMergeGroups,
  normalizeIngredientName,
} from "./ingredient-merge-candidates";

describe("normalizeIngredientName", () => {
  it("strips a 'for the pan' suffix", () => {
    expect(normalizeIngredientName("Butter for the pan")).toBe("butter");
  });

  it("strips parentheticals", () => {
    expect(normalizeIngredientName("sugar (for dusting)")).toBe("sugar");
  });

  it("strips a trailing comma note", () => {
    expect(normalizeIngredientName("butter, softened")).toBe("butter");
  });

  it("lowercases and trims whitespace", () => {
    expect(normalizeIngredientName("  Salt ")).toBe("salt");
  });
});

describe("detectMergeGroups", () => {
  it("groups butter variants together", () => {
    const groups = detectMergeGroups([
      { name: "butter" },
      { name: "Butter for the pan" },
      { name: "All-purpose flour" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => m.name)).toEqual([
      "butter",
      "Butter for the pan",
    ]);
  });

  it("does not merge distinct sugars", () => {
    const groups = detectMergeGroups([
      { name: "White sugar" },
      { name: "powdered sugar" },
      { name: "Demerara sugar" },
    ]);
    expect(groups).toHaveLength(0);
  });

  it("returns no groups for all-unique input", () => {
    const groups = detectMergeGroups([{ name: "flour" }, { name: "eggs" }]);
    expect(groups).toHaveLength(0);
  });
});
