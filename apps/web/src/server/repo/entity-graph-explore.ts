import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphBranch,
  EntityGraphEdge,
  EntityGraphExploreInput,
  EntityGraphExploreOutput,
  EntityGraphNode,
  EntityGraphOutput,
  EntityGraphPath,
} from "@cubby/schemas/entity-graph";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { withTransaction } from "~/server/repo/database-helpers";

import { readEntityGraph } from "./entity-graph";

export type GraphExploreLimits = {
  maxNodes: number;
  maxEdges: number;
  maxReads: number;
  maxRootsPerRead: number;
  pageSize: number;
  deadlineMs: number;
  maxPathsPerNode: number;
};

const DEFAULT_LIMITS: GraphExploreLimits = {
  maxNodes: 500,
  maxEdges: 1_000,
  maxReads: 32,
  maxRootsPerRead: 25,
  pageSize: 12,
  deadlineMs: 10_000,
  maxPathsPerNode: 3,
};

type GraphExploreReader = (
  roots: readonly EntityRef[],
  pageSize: number,
) => Promise<EntityGraphOutput>;

type Visit = {
  distance: number;
  paths: EntityGraphPath[];
};

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
};

const pathRecordKey = (path: EntityGraphPath): string =>
  path.nodeRefs
    .map((ref) => entityRefKey(ref.entityType, ref.entityId))
    .join(">");

const pathKey = (path: EntityGraphPath): string =>
  `${pathRecordKey(path)}|${path.edgeIds.join(">")}`;

const addPath = (
  visit: Visit,
  path: EntityGraphPath,
  maxPaths: number,
): void => {
  const sequence = pathRecordKey(path);
  const existingIndex = visit.paths.findIndex(
    (candidate) => pathRecordKey(candidate) === sequence,
  );
  if (existingIndex >= 0) {
    const existing = visit.paths[existingIndex];
    if (existing && pathKey(path).localeCompare(pathKey(existing)) < 0) {
      visit.paths[existingIndex] = path;
    }
  } else {
    visit.paths.push(path);
  }
  visit.paths.sort((left, right) =>
    pathKey(left).localeCompare(pathKey(right)),
  );
  visit.paths.splice(maxPaths);
};

const branchKey = (branch: EntityGraphBranch): string =>
  `${entityRefKey(branch.root.entityType, branch.root.entityId)}|${branch.relationshipKey}`;

const uniqueBranches = (
  branches: readonly EntityGraphBranch[],
  nodeKeys: ReadonlySet<string>,
  edges: ReadonlyMap<string, EntityGraphEdge>,
): EntityGraphBranch[] => [
  ...new Map<string, EntityGraphBranch>(
    branches.map((branch): [string, EntityGraphBranch] => {
      const firstOmitted = branch.items.findIndex((item) => {
        const itemKey = entityRefKey(item.entityType, item.entityId);
        return (
          !nodeKeys.has(itemKey) ||
          !branch.edgeIds.some((id) => {
            const edge = edges.get(id);
            return (
              edge !== undefined &&
              [edge.source, edge.target].some(
                (endpoint) =>
                  entityRefKey(endpoint.entityType, endpoint.entityId) ===
                  itemKey,
              )
            );
          })
        );
      });
      const items =
        firstOmitted < 0 ? branch.items : branch.items.slice(0, firstOmitted);
      const itemKeys = new Set(
        items.map((item) => entityRefKey(item.entityType, item.entityId)),
      );
      return [
        branchKey(branch),
        {
          ...branch,
          items,
          edgeIds: branch.edgeIds.filter((id) => {
            const edge = edges.get(id);
            return (
              edge !== undefined &&
              [edge.source, edge.target].some((endpoint) =>
                itemKeys.has(
                  entityRefKey(endpoint.entityType, endpoint.entityId),
                ),
              )
            );
          }),
          nextOffset:
            firstOmitted < 0 ? branch.nextOffset : Math.max(0, firstOmitted),
        },
      ];
    }),
  ).values(),
];

/**
 * Bounded breadth-first exploration. A branch page is intentionally read once:
 * its next offset is returned for an explicit client expansion instead of
 * letting one broad relationship consume the aggregate budget.
 */
// Frontier batching, alternate shortest routes, cycles, and four independent
// completion causes share one state machine so partial output stays honest.
// eslint-disable-next-line complexity
export async function exploreEntityGraph(
  root: EntityRef,
  requestedDepth: 1 | 2 | 3,
  readFrontier: GraphExploreReader,
  options: {
    limits?: Partial<GraphExploreLimits>;
    now?: () => number;
  } = {},
): Promise<EntityGraphExploreOutput> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const deadline = now() + limits.deadlineMs;
  const rootKey = entityRefKey(root.entityType, root.entityId);
  const acceptedRefs = new Map<string, EntityRef>([[rootKey, root]]);
  const nodes = new Map<string, EntityGraphNode>();
  const edges = new Map<string, EntityGraphEdge>();
  const branches: EntityGraphBranch[] = [];
  const visits = new Map<string, Visit>([
    [rootKey, { distance: 0, paths: [{ nodeRefs: [root], edgeIds: [] }] }],
  ]);
  let frontier = [root];
  let frontierDepth = 0;
  let reachedDepth = 0;
  let reads = 0;
  let budgetReached = false;
  let paginationReached = false;

  while (frontier.length > 0 && frontierDepth < requestedDepth) {
    const next = new Map<string, EntityRef>();
    for (const batch of chunks(frontier, limits.maxRootsPerRead)) {
      if (reads >= limits.maxReads || now() >= deadline) {
        budgetReached = true;
        break;
      }
      reads += 1;
      const graph = await readFrontier(batch, limits.pageSize);
      if (graph.truncated) budgetReached = true;
      for (const branch of graph.branches) {
        branches.push(branch);
        if (branch.nextOffset !== null) paginationReached = true;
      }
      for (const node of graph.nodes) {
        const key = entityRefKey(node.entityType, node.entityId);
        if (!acceptedRefs.has(key)) {
          if (acceptedRefs.size >= limits.maxNodes) {
            budgetReached = true;
            continue;
          }
          acceptedRefs.set(key, node);
        }
        nodes.set(key, node);
      }

      const batchKeys = new Set(
        batch.map((item) => entityRefKey(item.entityType, item.entityId)),
      );
      for (const edge of [...graph.edges].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        const sourceKey = entityRefKey(
          edge.source.entityType,
          edge.source.entityId,
        );
        const targetKey = entityRefKey(
          edge.target.entityType,
          edge.target.entityId,
        );
        if (!acceptedRefs.has(sourceKey) || !acceptedRefs.has(targetKey)) {
          budgetReached = true;
          continue;
        }
        if (!edges.has(edge.id) && edges.size >= limits.maxEdges) {
          budgetReached = true;
          continue;
        }
        edges.set(edge.id, edge);
        const orientations: [string, EntityRef][] = [];
        if (batchKeys.has(sourceKey))
          orientations.push([sourceKey, edge.target]);
        if (batchKeys.has(targetKey))
          orientations.push([targetKey, edge.source]);
        for (const [fromKey, neighbor] of orientations) {
          const from = visits.get(fromKey);
          if (!from || from.distance !== frontierDepth) continue;
          const neighborKey = entityRefKey(
            neighbor.entityType,
            neighbor.entityId,
          );
          const distance = frontierDepth + 1;
          let visit = visits.get(neighborKey);
          if (!visit) {
            visit = { distance, paths: [] };
            visits.set(neighborKey, visit);
            next.set(neighborKey, neighbor);
            reachedDepth = Math.max(reachedDepth, distance);
          }
          if (visit.distance !== distance) continue;
          for (const path of from.paths) {
            if (
              path.nodeRefs.some(
                (ref) =>
                  entityRefKey(ref.entityType, ref.entityId) === neighborKey,
              )
            ) {
              continue;
            }
            addPath(
              visit,
              {
                nodeRefs: [...path.nodeRefs, neighbor],
                edgeIds: [...path.edgeIds, edge.id],
              },
              limits.maxPathsPerNode,
            );
          }
        }
      }
      if (budgetReached) break;
    }
    frontier = [...next.values()].sort((left, right) =>
      entityRefKey(left.entityType, left.entityId).localeCompare(
        entityRefKey(right.entityType, right.entityId),
      ),
    );
    frontierDepth += 1;
    if (budgetReached) break;
  }

  const candidateNodeKeys = new Set(nodes.keys());
  const candidateEdges = [...edges.values()].filter(
    (edge) =>
      candidateNodeKeys.has(
        entityRefKey(edge.source.entityType, edge.source.entityId),
      ) &&
      candidateNodeKeys.has(
        entityRefKey(edge.target.entityType, edge.target.entityId),
      ),
  );
  const candidateEdgeIds = new Set(candidateEdges.map((edge) => edge.id));
  const paths = [...visits.entries()]
    .filter(([key]) => key !== rootKey && candidateNodeKeys.has(key))
    .flatMap(([, visit]) => visit.paths)
    .filter((path) => path.edgeIds.every((id) => candidateEdgeIds.has(id)))
    .sort(
      (left, right) =>
        left.edgeIds.length - right.edgeIds.length ||
        pathKey(left).localeCompare(pathKey(right)),
    );
  const retainedNodeKeys = new Set(
    paths
      .flatMap((path) => path.nodeRefs)
      .map((ref) => entityRefKey(ref.entityType, ref.entityId)),
  );
  if (nodes.has(rootKey)) retainedNodeKeys.add(rootKey);
  const retainedEdges = candidateEdges.filter(
    (edge) =>
      retainedNodeKeys.has(
        entityRefKey(edge.source.entityType, edge.source.entityId),
      ) &&
      retainedNodeKeys.has(
        entityRefKey(edge.target.entityType, edge.target.entityId),
      ),
  );
  const retainedEdgesById = new Map(
    retainedEdges.map((edge) => [edge.id, edge]),
  );
  const status = budgetReached
    ? "budget-limit"
    : paginationReached
      ? "pagination-limit"
      : frontier.length > 0 && frontierDepth >= requestedDepth
        ? "depth-limit"
        : "exhausted";

  return {
    nodes: [...nodes.entries()]
      .filter(([key]) => retainedNodeKeys.has(key))
      .map(([, node]) => node),
    edges: retainedEdges,
    branches: uniqueBranches(branches, retainedNodeKeys, retainedEdgesById),
    truncated: status !== "exhausted",
    paths,
    completion: { status, requestedDepth, reachedDepth },
  };
}

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

const DEADLINE_MS = 10_000;
class GraphExploreDeadlineError extends Error {}

/** Explore a live entity neighborhood within one bounded transaction. */
export async function getEntityGraphExplore(
  db: Database,
  input: EntityGraphExploreInput,
): Promise<EntityGraphExploreOutput> {
  const requestedDepth = input.depth ?? 1;
  const deadline = Date.now() + DEADLINE_MS;
  try {
    return await withTransaction(db, async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${String(DEADLINE_MS)}, true)`,
      );
      const beforeQuery = async () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new GraphExploreDeadlineError();
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${String(remaining)}, true)`,
        );
      };
      return exploreEntityGraph(
        input.root,
        requestedDepth,
        async (roots, pageSize) => {
          try {
            return await readEntityGraph(
              tx,
              { roots: [...roots], offset: 0, limit: pageSize },
              {
                includeImages: true,
                beforeQuery,
                isImageHydrationDeadline: (error) =>
                  error instanceof GraphExploreDeadlineError ||
                  isStatementTimeout(error),
              },
            );
          } catch (error) {
            if (
              !(error instanceof GraphExploreDeadlineError) &&
              !isStatementTimeout(error)
            ) {
              throw error;
            }
            return {
              nodes: [],
              edges: [],
              branches: [],
              truncated: true,
            };
          }
        },
        { limits: { deadlineMs: Math.max(0, deadline - Date.now()) } },
      );
    });
  } catch (error) {
    if (
      !(error instanceof GraphExploreDeadlineError) &&
      !isStatementTimeout(error)
    ) {
      throw error;
    }
    return {
      nodes: [],
      edges: [],
      branches: [],
      truncated: true,
      paths: [],
      completion: {
        status: "budget-limit",
        requestedDepth,
        reachedDepth: 0,
      },
    };
  }
}
