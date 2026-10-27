import { entityManifest } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { ENTITY_EDGE_SPECS } from "~/server/generic/entity-links/repo/entity-edge-source";

describe("ENTITY_EDGE_OWNERS", () => {
  // Regression guard for the graph read: an edge whose source cannot be named
  // would silently vanish from Connections and the orphan finder.
  it("names a source kind for every graph-visible edge", () => {
    const unnamed = ENTITY_EDGE_SPECS.filter(
      (spec) =>
        spec.source.kind !== "identity" &&
        !entityManifest[spec.source.sourceKind].dbTable,
    ).map((spec) => spec.edgeKey);
    expect(unnamed).toEqual([]);
  });
});
