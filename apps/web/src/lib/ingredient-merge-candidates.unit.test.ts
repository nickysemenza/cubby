import { describe, expect, it } from "vitest";
import { detectMergeGroups } from "./ingredient-merge-candidates";

// Stand-in normalizer. The real canonicalization (strip "for the pan", parens,
// etc.) lives in and is tested by the recipebridge `normalize_ingredient_name`
// Rust crate; here we only exercise the grouping logic.
const lower = (s: string) => s.trim().toLowerCase();

describe("detectMergeGroups", () => {
  it("groups rows that share a normalized key, preserving order", () => {
    const groups = detectMergeGroups(
      [{ name: "Butter" }, { name: "butter" }, { name: "Flour" }],
      lower,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.normalized).toBe("butter");
    expect(groups[0]?.members.map((m) => m.name)).toEqual(["Butter", "butter"]);
  });

  it("does not group rows with distinct normalized names", () => {
    const groups = detectMergeGroups(
      [{ name: "white sugar" }, { name: "powdered sugar" }],
      lower,
    );
    expect(groups).toHaveLength(0);
  });

  it("skips rows whose normalized name is empty", () => {
    const groups = detectMergeGroups([{ name: "  " }, { name: "salt" }], lower);
    expect(groups).toHaveLength(0);
  });

  it("returns no groups for all-unique input", () => {
    const groups = detectMergeGroups(
      [{ name: "flour" }, { name: "eggs" }],
      lower,
    );
    expect(groups).toHaveLength(0);
  });
});
