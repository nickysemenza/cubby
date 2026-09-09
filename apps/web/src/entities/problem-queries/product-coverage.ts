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
  defineProblem({
    key: "productsWithTitleDerivableSize",
    problemClass: PROBLEM_CLASS.productsWithTitleDerivableSize,
    // Not `fast` despite needing no network: that lane's contract is DB-only
    // with no WASM, and the size is read by the Rust grammar.
    executionLane: "coverage",
    continuation: {
      kind: "none",
      reason:
        "Each result is a proposed conversion read off the title, not a product row a filter could reproduce.",
    },
    freshness: { kind: "live" },
    title: "Sizes stated in the title but not recorded",
    description:
      "Food or ingredient products whose own name states a size they have no conversion for, so no comparable unit price can be shown. Titles carrying a pack count are excluded — they read 6-12x too small.",
    emptyMessage:
      "Every food or ingredient product that states a size in its name has it recorded.",
    source: {
      kind: "derived",
      diagnostic: "title-derivable-unit-size",
      grain: "proposal",
      inputs: [{ entity: "product", filters: [] }],
      operations: [
        {
          label:
            "Shortlist food or ingredient products without mappings whose name mentions a size",
          detail:
            "Includes products categorized as food, linked to an ingredient, or carrying a positive USDA food ID.",
        },
        {
          label: "Parse the size with the ingredient grammar",
          detail:
            "Refuses pack counts, fractions, compatibility text, dimensions, and any title stating two different sizes.",
        },
      ],
    },
  }),
] as const satisfies readonly ProblemQuery[];
