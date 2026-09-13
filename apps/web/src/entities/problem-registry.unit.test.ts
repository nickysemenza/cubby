import { entitySchema } from "@cubby/schemas/entity";
import { PROBLEM_CLASS } from "@cubby/schemas/problems";
import { describe, expect, it } from "vitest";

import { diagnosticAdapters } from "~/server/services/problem-diagnostics.service";

import { getEntityFilters } from "./filter-manifest";
import { entityFilterUrlKeys } from "./filter-search-fields";
import {
  buildFiltersFromManifest,
  decodeFilters,
  encodeFilters,
} from "./filters";
import type { FilterSpecCore } from "./filters";
import { problemActionsFor } from "./problem-actions";
import {
  compileProblemFilters,
  problemFilterSpecs,
} from "./problem-filter-semantics";
import { basicProblemQueries } from "./problem-queries/basic";
import { derivedProblemQueries } from "./problem-queries/derived";
import { productCoverageProblemQueries } from "./problem-queries/product-coverage";
import { trackerProblemQueries } from "./problem-queries/tracker";
import type { DiagnosticKey } from "./problem-query";
import {
  expectedProblemKeys,
  problemQuery,
  problemQueryDeclarations,
} from "./problem-registry";
import {
  completeProblemQueryDeclarations,
  validateCompleteProblemRegistry,
} from "./problem-registry-validation";

describe("Problem Query registry", () => {
  it("composes every schema ProblemKey exactly once", () => {
    const definitions = problemQueryDeclarations();
    const keys = definitions.map((definition) => definition.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(expectedProblemKeys));
    expect(() => validateCompleteProblemRegistry(definitions)).not.toThrow();
    // "derived" sources aren't confined to derived.ts: product-coverage.ts and
    // tracker.ts each mix in one alongside their "entity" declarations. Count
    // every declared source array directly instead of hardcoding a total, so
    // a new Problem in any of them is reflected here automatically.
    const declaredDerivedCount = [
      ...basicProblemQueries,
      ...productCoverageProblemQueries,
      ...trackerProblemQueries,
      ...derivedProblemQueries,
    ].filter(({ source }) => source.kind === "derived").length;
    expect(
      definitions.filter(({ source }) => source.kind === "derived"),
    ).toHaveLength(declaredDerivedCount);
    expect(
      definitions.filter(({ source }) => source.kind === "entity"),
    ).toHaveLength(definitions.length - declaredDerivedCount);
    expect(keys).toContain("productsMissingPrice");
    expect(keys).toContain("overdueTasks");
    expect(keys).toContain("duplicateVendors");
    expect(problemQuery("duplicateVendors")?.source.kind).toBe("derived");
  });

  it("reuses the validated registry and indexed definition objects", () => {
    expect(problemQueryDeclarations()).toBe(problemQueryDeclarations());
    const definition = problemQuery("duplicateVendors");
    expect(definition).toBe(
      problemQueryDeclarations().find(({ key }) => key === "duplicateVendors"),
    );
    expect(problemQuery("duplicateVendors")).toBe(definition);
  });

  it("gives every definition explicit freshness and a legal continuation", () => {
    for (const definition of problemQueryDeclarations()) {
      expect(definition.freshness).toBeDefined();
      expect(definition.continuation.kind).toBe(
        definition.source.kind === "entity" ? "entity-list" : "none",
      );
    }
  });

  it("attaches only the Problems UI's real action capabilities", () => {
    const definitions = completeProblemQueryDeclarations();
    for (const definition of definitions) {
      expect(definition.actions).toEqual(problemActionsFor(definition.key));
      for (const action of definition.actions) {
        if (action.scope === "item") {
          // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
          expect(["item", "guided-flow"]).toContain(action.target);
        } else {
          // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
          expect(["canonical-query", "global-backfill"]).toContain(
            action.target,
          );
        }
      }
    }

    // The two destructive "Delete all" controls resolve their full server
    // populations through findAllViewProblemIds; cards themselves are samples.
    expect(
      definitions
        .flatMap((definition) =>
          definition.actions
            .filter((action) => action.target === "canonical-query")
            .map(() => definition.key),
        )
        .sort(),
    ).toEqual(
      [
        "unusedIngredientsWithProduct",
        "unusedIngredientsWithoutProduct",
      ].sort(),
    );
  });

  it("keeps every derived diagnostic explicit about its result contract", () => {
    const diagnostics = new Set<DiagnosticKey>();
    for (const definition of problemQueryDeclarations()) {
      if (definition.source.kind !== "derived") continue;

      expect(definition.executionLane).toBeTruthy();
      expect(definition.continuation.kind).toBe("none");
      expect(definition.source.diagnostic).toBeTruthy();
      expect(diagnostics.has(definition.source.diagnostic)).toBe(false);
      diagnostics.add(definition.source.diagnostic);
      expect(definition.source.grain).toBeTruthy();
      expect(definition.source.operations.length).toBeGreaterThan(0);
    }
    expect(new Set(Object.keys(diagnosticAdapters))).toEqual(diagnostics);
  });

  it("compiles every exact entity assembly for its ordinary list repository", () => {
    for (const definition of problemQueryDeclarations()) {
      if (definition.source.kind !== "entity") continue;
      const source = definition.source;
      expect(() =>
        compileProblemFilters(source.entity, source.filters),
      ).not.toThrow();
    }
  });

  it("keeps Problem semantics URL-serializable and aligned with the UI adapter", () => {
    for (const [entity, coreSpecs] of Object.entries(problemFilterSpecs)) {
      const parsedEntity = entitySchema.safeParse(entity);
      if (!parsedEntity.success) {
        throw new Error(`Unknown Problem filter entity: ${entity}`);
      }
      const uiSpecs = new Map(
        getEntityFilters(parsedEntity.data).map((spec) => [
          spec.columnId,
          spec,
        ]),
      );
      const urlKeys = new Set(entityFilterUrlKeys(parsedEntity.data));

      for (const core of coreSpecs) {
        const semantic = (spec: FilterSpecCore) => ({
          columnId: spec.columnId,
          field: spec.field,
          kind: spec.kind,
          urlKey: spec.urlKey,
          nullable: spec.nullable,
        });
        const normalized = semantic(core);
        const ui = uiSpecs.get(core.columnId);
        expect(
          ui,
          `${entity}.${core.columnId} needs a UI adapter spec`,
        ).toBeDefined();
        expect(urlKeys.has(normalized.urlKey ?? normalized.columnId)).toBe(
          true,
        );
        expect(ui?.field ?? ui?.columnId).toBe(
          normalized.field ?? normalized.columnId,
        );
        expect(ui?.kind).toBe(normalized.kind);
        expect(ui?.urlKey).toBe(normalized.urlKey);
        expect(ui?.nullable).toEqual(normalized.nullable);
      }
    }
  });

  it("round-trips every exact assembly through the shared URL codec", () => {
    for (const definition of problemQueryDeclarations()) {
      if (definition.source.kind !== "entity") continue;
      const { entity, filters } = definition.source;
      const specs = getEntityFilters(entity);
      const values = new Map(filters.map(({ id, value }) => [id, value]));
      const encoded = encodeFilters(specs, (columnId) => values.get(columnId));
      const decoded = new Map(
        decodeFilters(specs, encoded).map((f) => [f.id, f.value]),
      );

      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(
        buildFiltersFromManifest(specs, (columnId) => decoded.get(columnId)),
        definition.key,
      ).toEqual(compileProblemFilters(entity, filters));
    }
  });

  it("keeps the expected key roster sourced from the schema", () => {
    expect(expectedProblemKeys).toEqual(Object.keys(PROBLEM_CLASS));
  });
});
