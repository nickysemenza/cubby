import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphPathsInput,
  EntityGraphPathsOutput,
} from "@cubby/schemas/entity-graph";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { withTransaction } from "~/server/repo/database-helpers";

import { readEntityGraph } from "./entity-graph";
import { searchEntityGraphPaths } from "./entity-graph-path-search";

const uniqueRefs = (refs: readonly EntityRef[]): EntityRef[] => [
  ...new Map(
    refs.map((ref) => [entityRefKey(ref.entityType, ref.entityId), ref]),
  ).values(),
];

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
};

const databaseErrorNodeSchema = z.object({
  code: z.string().optional(),
  cause: z.unknown().optional(),
});
const unparsedDatabaseErrorSchema = z.unknown();
type UnparsedDatabaseError = z.input<typeof unparsedDatabaseErrorSchema>;

const isStatementTimeout = (error: UnparsedDatabaseError): boolean => {
  let candidate = error;
  for (let depth = 0; depth < 8; depth += 1) {
    const parsed = databaseErrorNodeSchema.safeParse(candidate);
    if (!parsed.success) return false;
    if (parsed.data.code === "57014") return true;
    candidate = parsed.data.cause;
  }
  return false;
};

const edgePairKey = (left: EntityRef, right: EntityRef): string =>
  [
    entityRefKey(left.entityType, left.entityId),
    entityRefKey(right.entityType, right.entityId),
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
      for (const roots of chunks(refs, 25)) {
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
        hydrated.map((node) => entityRefKey(node.entityType, node.entityId)),
      );
      const paths = result.paths.filter((path) =>
        path.nodeRefs.every((ref) =>
          liveKeys.has(entityRefKey(ref.entityType, ref.entityId)),
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
