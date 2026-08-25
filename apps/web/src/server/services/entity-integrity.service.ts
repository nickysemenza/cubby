import type {
  IntegrityCatalog,
  PhysicalEdge,
} from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { sumBy } from "es-toolkit";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { ENTITY_LIFECYCLE_REGISTRY } from "~/server/repo/entity-lifecycle-registry";

/** Flatten one entity's incoming edges, pairing each with its stable semantics. */
function physicalEdgesFor(
  entity: (typeof allEntities)[number],
): PhysicalEdge[] {
  const edges = INCOMING_EDGES[entity] as Record<
    string,
    { column: unknown; unconstrained?: true }
  >;
  const semantics = ENTITY_EDGE_SEMANTICS[entity] as Record<
    string,
    PhysicalEdge["semantics"]
  >;

  return Object.entries(edges).map(([edgeKey, edge]) => {
    const column = edge.column as { table: unknown; name: string };
    if (!is(column.table, PgTable)) {
      throw new Error(`Edge "${edgeKey}" is not attached to a PgTable.`);
    }
    const entry = semantics[edgeKey];
    if (!entry) {
      throw new Error(`Edge "${edgeKey}" has no ENTITY_EDGE_SEMANTICS entry.`);
    }
    return {
      edgeKey,
      targetEntity: entity,
      sourceTable: getTableConfig(column.table).name,
      sourceColumn: column.name,
      constrained: edge.unconstrained !== true,
      semantics: entry,
    };
  });
}

/**
 * The static entity-integrity catalog: relationships and their provenance,
 * physical incoming edges with their stable semantics, and every operation's
 * dispositions.
 */
export function buildIntegrityCatalog(): IntegrityCatalog {
  const entities = allEntities.map((entity) => ({
    entity,
    dbTable: entityManifest[entity].dbTable,
    relationships: [...entityManifest[entity].relationships],
    lifecycle: entityManifest[entity].lifecycle,
    incomingEdges: physicalEdgesFor(entity),
  }));

  const operations = ENTITY_LIFECYCLE_REGISTRY.map((entry) => ({
    entity: entry.entity,
    operation: entry.operation,
    dispositions: Object.entries(entry.policy).map(
      ([edgeKey, disposition]) => ({
        edgeKey,
        // The policy values are `as const` object literals that structurally
        // extend OperationDisposition (product's delete policy carries an extra
        // `reason`/`label`); narrow to the three fields the wire contract has.
        disposition: {
          code: disposition.code,
          effect: disposition.effect,
          description: disposition.description,
        },
      }),
    ),
  }));

  const allEdges = entities.flatMap((e) => e.incomingEdges);
  return {
    entities,
    operations,
    coverage: {
      relationships: sumBy(entities, (e) => e.relationships.length),
      incomingEdges: allEdges.length,
      auditedEdges: allEdges.filter(
        (e) => e.semantics.liveness.kind === "must-target-live",
      ).length,
      exemptEdges: allEdges.filter(
        (e) => e.semantics.liveness.kind === "allow-target-deleted",
      ).length,
      operations: operations.length,
    },
  };
}
