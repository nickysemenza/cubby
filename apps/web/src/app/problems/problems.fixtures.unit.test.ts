import { allProblemsSchema } from "@cubby/schemas/problems";
import { describe, expect, it } from "vitest";
import { buildUnitCoverageItems } from "./components/unit-coverage-items";
import {
  makeAllProblems,
  makeIngredientPartialCoverage,
  makeIslandedProduct,
  makeProductWithoutMappings,
} from "./problems.fixtures";

describe("problems fixtures", () => {
  it("makeAllProblems produces schema-valid data", () => {
    expect(allProblemsSchema.safeParse(makeAllProblems()).success).toBe(true);
  });

  it("overrides flow through (objects deep-merge, arrays replace)", () => {
    const problems = makeAllProblems({
      totalProblems: 3,
      orphanedProducts: [],
    });
    expect(problems.totalProblems).toBe(3);
    expect(problems.orphanedProducts).toEqual([]);
  });

  it("per-type helpers feed buildUnitCoverageItems", () => {
    const items = buildUnitCoverageItems(
      [makeProductWithoutMappings({ name: "Salt" })],
      [makeIngredientPartialCoverage()],
      [makeIslandedProduct()],
    );
    expect(items.map((i) => i.kind)).toEqual(["none", "partial", "islanded"]);
    const none = items[0];
    expect(none?.kind === "none" && none.name).toBe("Salt");
  });
});
