import { connectionCatalog } from "@cubby/schemas/connected-views";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityRelationshipSchema } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  localRelationshipEntities,
  relationshipQueryDefinition,
} from "@cubby/schemas/relationship-query-definitions";
import { expect, it } from "vitest";

import { compiledConnectedRoutes } from "./connected-records";

it("compiles every curated and existing relation table through local traversals", () => {
  for (const source of allEntities) {
    for (const view of [
      ...connectionCatalog.views(source),
      ...connectionCatalog.views(source, "context"),
    ]) {
      expect(compiledConnectedRoutes(source, view.key).length).toBeGreaterThan(
        0,
      );
    }
    for (const section of entitySummary[source].detail.sections) {
      if (section.kind !== "relation") continue;
      const relation = entityManifest[source].relationships.find(
        (candidate) => candidate.key === section.relation,
      );
      // A derived relation is its list filter; it has no edge path.
      const routes = compiledConnectedRoutes(
        source,
        `relation:${section.relation}`,
      ).length;
      expect({ relation: section.relation, compiles: routes > 0 }).toEqual({
        relation: section.relation,
        compiles: relation?.provenance.kind !== "derived",
      });
    }
  }
});

it("gives every public local reference a discoverable target group", () => {
  expect([...localRelationshipEntities].sort()).toEqual(
    allEntities
      .filter((entity) => entityManifest[entity].dbTable !== null)
      .sort(),
  );
  for (const source of allEntities) {
    if (entityManifest[source].dbTable === null) continue;
    const targets = new Set(
      connectionCatalog.views(source).map((view) => view.target),
    );
    for (const field of entityFieldModels[source].fields) {
      if (!field.reference) continue;
      expect(
        targets.has(field.reference.entity),
        `${source}.${field.key} has no navigation disposition`,
      ).toBe(true);
    }
  }
});

it("keeps query endpoints and inverses on their canonical evidence owner", () => {
  for (const source of allEntities) {
    for (const literal of entityManifest[source].relationships) {
      const relation = entityRelationshipSchema.parse(literal);
      for (const named of [relation, ...relation.sources]) {
        const provenance = named.provenance;
        if (provenance.kind !== "query") continue;
        const query = relationshipQueryDefinition(provenance.query);
        expect([source, relation.target]).toEqual(
          provenance.reverse
            ? [query.target, query.source]
            : [query.source, query.target],
        );
        expect(named.inverse?.steps).toEqual([
          {
            edge: `Relationship.${query.key}`,
            direction: provenance.reverse ? "outgoing" : "incoming",
          },
        ]);
      }
    }
  }
});
