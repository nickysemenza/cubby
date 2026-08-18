import { describe, expect, it } from "vitest";
import type { DiagnosticKey } from "~/entities/problem-query";
import { diagnosticAdapters } from "./problem-diagnostics.service";

describe("Problem diagnostic adapters", () => {
  it("registers every supported derived diagnostic exactly once", () => {
    const expected = [
      "duplicate-product-identities",
      "orphaned-products",
      "tools-used-outside-ownership",
      "orphaned-entity-embeddings",
      "entities-missing-embeddings",
      "stale-parent-recipes",
      "manufacturer-spelling-variants",
      "duplicate-vendors",
      "referential-liveness-violations",
      "products-with-better-upc-data",
      "duplicate-spend-candidates",
      "duplicate-financial-transaction-source-refs",
      "duplicate-financial-account-source-aliases",
      "invalid-financial-json",
      "incomplete-statement-imports",
      "project-date-window-drift",
    ] as const satisfies readonly DiagnosticKey[];

    expect(Object.keys(diagnosticAdapters).sort()).toEqual(
      [...expected].sort(),
    );
    expect(
      Object.values(diagnosticAdapters).every(
        (adapter) => typeof adapter.run === "function",
      ),
    ).toBe(true);
  });
});
