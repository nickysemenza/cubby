import { describe, expect, it } from "vitest";

import type { DiagnosticKey } from "~/entities/problem-query";

import { diagnosticAdapters } from "./problem-diagnostics.service";

describe("Problem diagnostic adapters", () => {
  it("registers every supported derived diagnostic exactly once", () => {
    const expected = [
      "duplicate-product-identities",
      "orphaned-products",
      "partially-imported-cookbooks",
      "tools-used-outside-ownership",
      "entities-missing-embeddings",
      "stale-parent-recipes",
      "weight-sold-products",
      "manufacturer-spelling-variants",
      "duplicate-vendors",
      "referential-liveness-violations",
      "dependency-cycles",
      "products-with-better-upc-data",
      "duplicate-spend-candidates",
      "duplicate-financial-transaction-source-refs",
      "duplicate-financial-account-source-aliases",
      "invalid-financial-json",
      "incomplete-statement-imports",
      "import-findings",
      "title-derivable-unit-size",
      "project-date-window-drift",
    ] as const satisfies readonly DiagnosticKey[];

    expect(Object.keys(diagnosticAdapters).sort()).toEqual(
      [...expected].sort(),
    );
    for (const adapter of Object.values(diagnosticAdapters)) {
      expect(adapter.sample).toBeTypeOf("function");
      expect(adapter.count).toBeTypeOf("function");
    }
  });
});
