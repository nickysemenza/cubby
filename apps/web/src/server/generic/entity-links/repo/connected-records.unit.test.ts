import { connectionCatalog } from "@cubby/schemas/connected-views";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
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
