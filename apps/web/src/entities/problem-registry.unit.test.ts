import { PROBLEM_CLASS, type ProblemKey } from "@cubby/schemas/problems";
import { describe, expect, it } from "vitest";
import { diagnosticAdapters } from "~/server/services/problem-diagnostics.service";
import { getEntityFilters } from "./filter-manifest";
import { entityFilterUrlKeys } from "./filter-search-fields";
import {
  buildFiltersFromManifest,
  decodeFilters,
  encodeFilters,
} from "./filters";
import { problemActionsFor } from "./problem-actions";
import {
  compileProblemFilters,
  problemFilterSpecs,
} from "./problem-filter-semantics";
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
    expect(
      definitions.filter(({ source }) => source.kind === "entity"),
    ).toHaveLength(34);
    expect(
      definitions.filter(({ source }) => source.kind === "derived"),
    ).toHaveLength(18);
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
          expect(["item", "guided-flow"]).toContain(action.target);
        } else {
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
    expect(diagnostics.size).toBe(18);
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
      const uiSpecs = new Map(
        getEntityFilters(entity as Parameters<typeof getEntityFilters>[0]).map(
          (spec) => [spec.columnId, spec],
        ),
      );
      const urlKeys = new Set(
        entityFilterUrlKeys(entity as Parameters<typeof getEntityFilters>[0]),
      );

      for (const core of coreSpecs) {
        // Individual declarative specs omit irrelevant optional fields, so the
        // readonly union needs widening before comparing its shared contract.
        const semantic = core as {
          columnId: string;
          field?: string;
          kind: string;
          urlKey?: string;
          nullable?: unknown;
        };
        const ui = uiSpecs.get(core.columnId);
        expect(
          ui,
          `${entity}.${core.columnId} needs a UI adapter spec`,
        ).toBeDefined();
        expect(urlKeys.has(semantic.urlKey ?? semantic.columnId)).toBe(true);
        expect(ui?.field ?? ui?.columnId).toBe(
          semantic.field ?? semantic.columnId,
        );
        expect(ui?.kind).toBe(semantic.kind);
        expect(ui?.urlKey).toBe(semantic.urlKey);
        expect(ui?.nullable).toEqual(semantic.nullable);
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

      expect(
        buildFiltersFromManifest(specs, (columnId) => decoded.get(columnId)),
        definition.key,
      ).toEqual(compileProblemFilters(entity, filters));
    }
  });

  it("keeps the expected key roster sourced from the schema", () => {
    expect(expectedProblemKeys).toEqual(
      Object.keys(PROBLEM_CLASS) as ProblemKey[],
    );
  });
});
