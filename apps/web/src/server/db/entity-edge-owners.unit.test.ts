import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { ENTITY_EDGE_SPECS } from "~/server/repo/entity-edge-source";

import { ENTITY_EDGE_OWNERS } from "./entity-edge-owners";
import { INCOMING_EDGES } from "./entity-incoming-edges";

const entityTables: ReadonlySet<string> = new Set(
  allEntities.flatMap((entity) => entityManifest[entity].dbTable ?? []),
);

describe("ENTITY_EDGE_OWNERS", () => {
  it("classifies exactly the non-entity tables that carry an edge column", () => {
    const edgeTables = new Set(
      allEntities.flatMap((entity) =>
        Object.values(INCOMING_EDGES[entity]).flatMap((edge) =>
          is(edge.column.table, PgTable)
            ? [getTableConfig(edge.column.table).name]
            : [],
        ),
      ),
    );
    const nonEntity = [...edgeTables].filter(
      (table) => !entityTables.has(table),
    );
    expect(Object.keys(ENTITY_EDGE_OWNERS).sort()).toEqual(nonEntity.sort());
  });

  // Regression guard for the graph read: an edge whose source cannot be named
  // would silently vanish from Connections and the orphan finder.
  it("names a source kind for every graph-visible edge", () => {
    expect(ENTITY_EDGE_SPECS.length).toBeGreaterThan(0);
    const unnamed = ENTITY_EDGE_SPECS.filter(
      (spec) =>
        spec.source.kind !== "identity" &&
        !entityManifest[spec.source.sourceKind].dbTable,
    ).map((spec) => spec.edgeKey);
    expect(unnamed).toEqual([]);
  });
});
