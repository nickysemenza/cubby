import { integrityCatalogSchema } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { ENTITY_LIFECYCLE_REGISTRY } from "~/server/repo/entity-lifecycle-registry";
import { buildIntegrityCatalog } from "./entity-integrity";

/**
 * The catalog is a projection of compile-time constants, so most of its
 * correctness is already type-enforced. What is NOT type-enforced — and what
 * these cover — is that the flattening actually preserves what it projects:
 * that no edge is dropped on the way to the wire, that the derived counts the
 * UI renders as headline metrics are the real ones, and that the whole payload
 * satisfies its own schema (the procedure `.output()`-parses it, so a drift
 * here is a runtime 500, invisible to `tsc`).
 */
describe("integrity catalog", () => {
  const catalog = buildIntegrityCatalog();

  it("satisfies its own wire schema", () => {
    expect(() => integrityCatalogSchema.parse(catalog)).not.toThrow();
  });

  it("covers every entity exactly once", () => {
    expect(catalog.entities.map((e) => e.entity).sort()).toEqual(
      [...allEntities].sort(),
    );
  });

  it("projects every incoming edge without dropping or inventing one", () => {
    for (const entry of catalog.entities) {
      expect(entry.incomingEdges.map((e) => e.edgeKey).sort()).toEqual(
        Object.keys(INCOMING_EDGES[entry.entity]).sort(),
      );
      // Each edge keeps the semantics declared for it, not a neighbour's.
      for (const edge of entry.incomingEdges) {
        const declared = (
          ENTITY_EDGE_SEMANTICS[entry.entity] as Record<string, unknown>
        )[edge.edgeKey];
        expect(edge.semantics).toEqual(declared);
      }
    }
  });

  it("derives sourceTable/sourceColumn that agree with the edge key", () => {
    // The key is `Table.column` by construction elsewhere; if the flattening
    // read the wrong Drizzle column these would disagree, and the Integrity
    // tab would confidently show the wrong table.
    for (const entry of catalog.entities) {
      for (const edge of entry.incomingEdges) {
        expect(`${edge.sourceTable}.${edge.sourceColumn}`).toBe(edge.edgeKey);
      }
    }
  });

  it("marks exactly `Location.parentId` as unconstrained", () => {
    const unconstrained = catalog.entities
      .flatMap((e) => e.incomingEdges)
      .filter((e) => !e.constrained)
      .map((e) => e.edgeKey);
    expect(unconstrained).toEqual(["Location.parentId"]);
  });

  it("counts audited and exempt edges to match the liveness rules", () => {
    const edges = catalog.entities.flatMap((e) => e.incomingEdges);
    expect(catalog.coverage.incomingEdges).toBe(edges.length);
    expect(catalog.coverage.auditedEdges + catalog.coverage.exemptEdges).toBe(
      edges.length,
    );
    // One deliberate exemption today: the preserved sub-recipe pointer.
    expect(catalog.coverage.exemptEdges).toBe(1);
    const exempt = edges.filter(
      (e) => e.semantics.liveness.kind === "allow-target-deleted",
    );
    expect(exempt.map((e) => e.edgeKey)).toEqual(["Ingredient.recipeId"]);
  });

  it("counts relationships and operations as declared", () => {
    expect(catalog.coverage.relationships).toBe(
      allEntities.reduce(
        (n, e) => n + entityManifest[e].relationships.length,
        0,
      ),
    );
    expect(catalog.coverage.operations).toBe(ENTITY_LIFECYCLE_REGISTRY.length);
  });

  it("carries a disposition for every edge of every operation it lists", () => {
    for (const op of catalog.operations) {
      expect(op.dispositions.map((d) => d.edgeKey).sort()).toEqual(
        Object.keys(INCOMING_EDGES[op.entity]).sort(),
      );
    }
  });
});
