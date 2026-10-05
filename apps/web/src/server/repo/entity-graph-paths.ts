import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphPathsInput,
  EntityGraphPathsOutput,
} from "@cubby/schemas/entity-graph";
import { sql } from "drizzle-orm";
import { chunk } from "es-toolkit";

import type { Database } from "~/server/db";
import { isStatementTimeout } from "~/server/errors/db-errors";
import { withTransaction } from "~/server/repo/database-helpers";

import { readEntityGraph } from "./entity-graph";
import { searchEntityGraphPaths } from "./entity-graph-path-search";

const uniqueRefs = (refs: readonly EntityRef[]): EntityRef[] => [
  ...new Map(
    refs.map((ref) => [entityRefKey(ref.entityKind, ref.entityId), ref]),
  ).values(),
];

const edgePairKey = (left: EntityRef, right: EntityRef): string =>
  [
    entityRefKey(left.entityKind, left.entityId),
    entityRefKey(right.entityKind, right.entityId),
  ]
    .sort()
    .join("|");

const DEADLINE_MS = 10_000;
class GraphPathDeadlineError extends Error {}

/** Find and hydrate up to three shortest path candidates through live edges. */
export async function getEntityGraphPaths(
  db: Database,
  input: EntityGraphPathsInput,
): Promise<EntityGraphPathsOutput> {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    return await withTransaction(db, async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${String(DEADLINE_MS)}, true)`,
      );
      const beforeQuery = async () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new GraphPathDeadlineError();
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${String(remaining)}, true)`,
        );
      };
      const result = await searchEntityGraphPaths(
        input.start,
        input.destination,
        async (roots, offset, limit) => {
          try {
            const graph = await readEntityGraph(
              tx,
              { roots: [...roots], offset, limit },
              { includeImages: false, beforeQuery },
            );
            const nextOffsets = graph.branches.flatMap((branch) =>
              branch.nextOffset === null ? [] : [branch.nextOffset],
            );
            return {
              nodes: graph.nodes,
              edges: graph.edges,
              nextOffset:
                nextOffsets.length === 0 ? null : Math.max(...nextOffsets),
              budgetExceeded: graph.truncated,
            };
          } catch (error) {
            if (
              !(error instanceof GraphPathDeadlineError) &&
              !isStatementTimeout(error)
            ) {
              throw error;
            }
            return {
              nodes: [],
              edges: [],
              nextOffset: null,
              budgetExceeded: true,
            };
          }
        },
        { limits: { deadlineMs: Math.max(0, deadline - Date.now()) } },
      );
      const refs = uniqueRefs(result.paths.flatMap((path) => path.nodeRefs));
      if (refs.length === 0) return { nodes: [], ...result };

      const hydratedPages = [];
      for (const roots of chunk(refs, 25)) {
        hydratedPages.push(
          await readEntityGraph(
            tx,
            { roots, relationshipKeys: [] },
            { includeImages: true, beforeQuery },
          ),
        );
      }
      const hydrated = hydratedPages.flatMap((page) => page.nodes);
      const liveKeys = new Set(
        hydrated.map((node) => entityRefKey(node.entityKind, node.entityId)),
      );
      const paths = result.paths.filter((path) =>
        path.nodeRefs.every((ref) =>
          liveKeys.has(entityRefKey(ref.entityKind, ref.entityId)),
        ),
      );
      const pairs = new Set(
        paths.flatMap((path) =>
          path.nodeRefs.slice(1).map((node, index) => {
            const previous = path.nodeRefs[index];
            if (!previous) {
              throw new Error("Path is missing its previous node");
            }
            return edgePairKey(previous, node);
          }),
        ),
      );
      return {
        nodes: hydrated,
        edges: result.edges.filter((edge) =>
          pairs.has(edgePairKey(edge.source, edge.target)),
        ),
        paths,
        completion: result.completion,
        shortestPathCertain: result.shortestPathCertain,
      };
    });
  } catch (error) {
    if (
      !(error instanceof GraphPathDeadlineError) &&
      !isStatementTimeout(error)
    ) {
      throw error;
    }
    return {
      nodes: [],
      edges: [],
      paths: [],
      completion: "budget-limit",
      shortestPathCertain: false,
    };
  }
}
