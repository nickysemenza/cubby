import { describe, expect, it } from "vitest";

import { compileTraversal, invertPath } from "./traversal";

describe("relatedness traversal", () => {
  it("reverses the edge order and travel direction", () => {
    const path = [
      { edge: "Expense.productId", direction: "incoming" as const },
      { edge: "Expense.purchaseId", direction: "outgoing" as const },
    ];
    expect(invertPath(path)).toEqual([
      { edge: "Expense.purchaseId", direction: "incoming" },
      { edge: "Expense.productId", direction: "outgoing" },
    ]);
  });

  it("derives aliases and per-table soft-delete guards", () => {
    const traversal = compileTraversal(
      "product",
      [
        { edge: "Expense.productId", direction: "incoming" },
        { edge: "Expense.purchaseId", direction: "outgoing" },
      ],
      "source",
    );
    expect(traversal).toMatchObject({
      rootTable: "Product",
      rootAlias: "source0",
      leafTable: "Purchase",
      leafAlias: "source2",
      hops: [
        { table: "Expense", alias: "source1", softDelete: true },
        { table: "Purchase", alias: "source2", softDelete: true },
      ],
    });
  });
});
