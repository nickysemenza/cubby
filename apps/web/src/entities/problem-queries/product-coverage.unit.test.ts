import { describe, expect, it } from "vitest";
import { FILTER_ANY } from "~/entities/filters";
import { compileProblemFilters } from "~/entities/problem-filter-semantics";
import { productCoverageProblemQueries } from "./product-coverage";

describe("product conversion coverage Problem queries", () => {
  it("compiles partial coverage to the product list's persisted predicates", () => {
    const query = productCoverageProblemQueries[0];
    expect(query.source).toMatchObject({
      kind: "entity",
      entity: "product",
      filters: [
        { id: "ingredient", value: FILTER_ANY },
        { id: "conversionCoverage", value: "partial" },
      ],
    });
    expect(compileProblemFilters("product", query.source.filters)).toEqual({
      ingredientPresenceFilter: "has",
      conversionCoverage: "partial",
    });
  });

  it("compiles islanding to the persisted topology predicate", () => {
    const query = productCoverageProblemQueries[1];
    expect(compileProblemFilters("product", query.source.filters)).toEqual({
      conversionTopology: "islanded",
    });
    expect(query.freshness).toEqual({
      kind: "projection",
      label: "Conversion coverage",
    });
  });
});
