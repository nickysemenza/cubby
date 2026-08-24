import {
  type IntegrityCatalog,
  integrityCatalogSchema,
  type PhysicalEdge,
  previewOperationInputSchema,
  previewOperationSchema,
} from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { sumBy } from "es-toolkit";
import {
  createTRPCRouter,
  protectedProcedure,
  strictOutput,
} from "~/server/api/trpc";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { ENTITY_LIFECYCLE_REGISTRY } from "~/server/repo/entity-lifecycle-registry";
import { previewOperation } from "./entity-integrity-preview";

/**
 * The static entity-integrity catalog: relationships and their provenance,
 * physical incoming edges with their stable semantics, and every operation's
 * dispositions.
 *
 * This exists because half the picture is unavoidably server-side. The manifest
 * (`relationships`, `lifecycle`) is plain data the browser could import
 * directly, but `INCOMING_EDGES` holds Drizzle column objects and the operation
 * policies live next to their repos — neither can cross the wire as-is. So the
 * server flattens them here, into shapes `@cubby/schemas/entity-integrity`
 * validates.
 *
 * It runs NO queries. Live findings come from the referential-liveness audit in
 * `problems.getFast`, which the Integrity tab reads from the same cache the
 * Problems page and navbar badge already populate — deliberately not a second
 * auditor endpoint.
 */

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

export const entityIntegrityRouter = createTRPCRouter({
  /**
   * What an attach or detach would do, without doing it. Read-only; the
   * mutation remains authoritative and rechecks inside its transaction.
   */
  previewOperation: protectedProcedure
    .input(previewOperationInputSchema)
    .output(strictOutput(previewOperationSchema))
    .query(({ ctx, input }) => previewOperation(ctx.db, input, new Date())),

  // Parsed on the way out: the catalog is assembled from `as const` constants,
  // so a shape error here is a compile-time-invisible drift (a policy value
  // missing `effect`, say) that would otherwise surface as a broken UI.
  catalog: protectedProcedure
    .output(strictOutput(integrityCatalogSchema))
    .query(() => buildIntegrityCatalog()),
});
