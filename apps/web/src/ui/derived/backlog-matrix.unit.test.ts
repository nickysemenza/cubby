import { describe, expect, it } from "vitest";

import { pivotDerivedBacklog } from "./backlog-matrix";

describe("pivotDerivedBacklog", () => {
  const matrix = pivotDerivedBacklog({
    total: 12,
    kinds: [
      { entity: "product", field: "price", count: 2 },
      { entity: "product", field: "dataQuality", count: 3 },
      { entity: "recipe", field: "totals", count: 0 },
      { entity: "recipe", field: "dataQuality", count: 1 },
      { entity: "location", field: "dataQuality", count: 4 },
    ],
  });

  it("keeps declaration order for rows and leads with shared fields", () => {
    expect(matrix.rows.map((row) => row.entity)).toEqual([
      "product",
      "recipe",
      "location",
    ]);
    expect(matrix.fields).toEqual(["dataQuality", "price", "totals"]);
  });

  it("separates undeclared cells from idle declared ones", () => {
    const recipe = matrix.rows[1];
    expect(recipe?.counts.get("totals")).toBe(0);
    expect(recipe?.counts.has("price")).toBe(false);
  });

  it("totals both axes and reports unattributed queue rows", () => {
    expect(matrix.rows.map((row) => row.total)).toEqual([5, 1, 4]);
    expect(matrix.fieldTotals.get("dataQuality")).toBe(8);
    expect(matrix.max).toBe(4);
    expect(matrix.attributed).toBe(10);
    expect(matrix.unattributed).toBe(2);
  });
});
