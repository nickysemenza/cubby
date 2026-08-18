import { PROBLEM_CLASS } from "@cubby/schemas/problems";
import { FILTER_ANY } from "~/entities/filters";
import { defineProblem, type ProblemQuery } from "~/entities/problem-query";

/**
 * Exact entity continuations for the two persisted conversion diagnostics.
 * The projection is rebuilt by the same WASM coverage scan that supplies the
 * legacy cards; a stale or unavailable row never appears as a healthy match.
 */
export const productCoverageProblemQueries = [
  defineProblem({
    key: "ingredientsWithPartialCoverage",
    problemClass: PROBLEM_CLASS.ingredientsWithPartialCoverage,
    executionLane: "coverage",
    continuation: { kind: "entity-list" },
    freshness: { kind: "projection", label: "Conversion coverage" },
    title: "Ingredients with partial conversion coverage",
    description:
      "Ingredient products with a persisted, incomplete effective conversion graph.",
    emptyMessage: "Every ingredient product has complete conversion coverage.",
    source: {
      kind: "entity",
      entity: "product",
      filters: [
        { id: "ingredient", value: FILTER_ANY },
        { id: "conversionCoverage", value: "partial" },
      ],
      sort: [{ id: "name", desc: false }],
      columnVisibility: {
        ingredient: true,
        unitMappingQuality: true,
        price: true,
      },
    },
  }),
  defineProblem({
    key: "productsWithIslandedMappings",
    problemClass: PROBLEM_CLASS.productsWithIslandedMappings,
    executionLane: "coverage",
    continuation: { kind: "entity-list" },
    freshness: { kind: "projection", label: "Conversion coverage" },
    title: "Products with islanded mappings",
    description:
      "Products whose persisted effective conversion graph has two or more disconnected islands.",
    emptyMessage: "Every product's conversion mappings are connected.",
    source: {
      kind: "entity",
      entity: "product",
      filters: [{ id: "conversionTopology", value: "islanded" }],
      sort: [{ id: "name", desc: false }],
      columnVisibility: { unitMappingQuality: true, price: true },
    },
  }),
] as const satisfies readonly ProblemQuery[];
