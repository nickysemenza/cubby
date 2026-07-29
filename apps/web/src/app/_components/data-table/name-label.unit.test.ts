import { describe, expect, it } from "vitest";
import { nameLabel } from "./name-label";

type Meal = { date: string };
const forMeal = (raw: unknown) =>
  nameLabel<Meal>(raw, { date: "2026-07-20" }, (m) => `Meal on ${m.date}`);

describe("nameLabel", () => {
  /** The regression: `String(null)` rendered the text "null" to the user. */
  it("never yields the string 'null'", () => {
    expect(forMeal(null).label).not.toContain("null");
    expect(forMeal(undefined).label).not.toContain("null");
  });

  it("falls back so an unnamed row stays identifiable", () => {
    expect(forMeal(null).label).toBe("Meal on 2026-07-20");
    expect(forMeal("").label).toBe("Meal on 2026-07-20");
  });

  /**
   * The editor must see "" for an unnamed row, NOT the fallback — prefilling
   * it with a derived label would persist that label as a real name.
   */
  it("keeps the stored value empty even when a fallback is shown", () => {
    const { stored, label } = forMeal(null);
    expect(stored).toBe("");
    expect(label).toBe("Meal on 2026-07-20");
  });

  it("passes a real name through untouched", () => {
    expect(forMeal("Taco night")).toEqual({
      stored: "Taco night",
      label: "Taco night",
    });
  });

  it("degrades to empty when there is no fallback", () => {
    expect(nameLabel(null, {}, undefined)).toEqual({ stored: "", label: "" });
  });
});
