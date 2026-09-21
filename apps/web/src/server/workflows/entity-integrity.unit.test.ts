import { integrityCatalogSchema } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { ENTITY_LIFECYCLE_REGISTRY } from "~/server/repo/entity-lifecycle-registry";
import { buildIntegrityCatalog } from "~/server/services/entity-integrity.service";

describe("integrity catalog", () => {
  const catalog = buildIntegrityCatalog();

  it("satisfies its published schema and covers every entity once", () => {
    expect(() => integrityCatalogSchema.parse(catalog)).not.toThrow();
    expect(catalog.entities.map((entry) => entry.entity).sort()).toEqual(
      [...allEntities].sort(),
    );
  });

  it("projects every incoming edge with its declared semantics", () => {
    for (const entry of catalog.entities) {
      expect(entry.incomingEdges.map((edge) => edge.edgeKey).sort()).toEqual(
        Object.keys(INCOMING_EDGES[entry.entity]).sort(),
      );
      expect(
        Object.fromEntries(
          entry.incomingEdges.map((edge) => [edge.edgeKey, edge.semantics]),
        ),
      ).toEqual(ENTITY_EDGE_SEMANTICS[entry.entity]);
      for (const edge of entry.incomingEdges) {
        expect(`${edge.sourceTable}.${edge.sourceColumn}`).toBe(edge.edgeKey);
      }
    }
  });

  it("preserves the declared liveness coverage", () => {
    const edges = catalog.entities.flatMap((entry) => entry.incomingEdges);
    expect(
      edges.filter((edge) => !edge.constrained).map((edge) => edge.edgeKey),
    ).toEqual([]);
    expect(catalog.coverage.incomingEdges).toBe(edges.length);
    expect(catalog.coverage.auditedEdges + catalog.coverage.exemptEdges).toBe(
      edges.length,
    );
    expect(catalog.coverage.exemptEdges).toBe(2);
    expect(
      edges
        .filter(
          (edge) => edge.semantics.liveness.kind === "allow-target-deleted",
        )
        .map((edge) => edge.edgeKey),
    ).toEqual(["Ingredient.recipeId", "ImportRunTarget.purchaseId"]);
  });

  it("counts declared relationships, operations, and dispositions", () => {
    expect(catalog.coverage.relationships).toBe(
      allEntities.reduce(
        (total, entity) => total + entityManifest[entity].relationships.length,
        0,
      ),
    );
    expect(catalog.coverage.operations).toBe(ENTITY_LIFECYCLE_REGISTRY.length);
    for (const operation of catalog.operations) {
      expect(operation.owner).toBe(
        entityInspectorMetadata[operation.entity].operationOwners[
          operation.operation
        ],
      );
      expect(
        operation.dispositions.map((disposition) => disposition.edgeKey).sort(),
      ).toEqual(Object.keys(INCOMING_EDGES[operation.entity]).sort());
    }
    expect(catalog.operations).toContainEqual(
      expect.objectContaining({
        entity: "cookbook",
        operation: "delete",
        owner: "workflow",
      }),
    );
  });
});
