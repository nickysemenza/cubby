import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphEdge,
  EntityGraphPath,
} from "@cubby/schemas/entity-graph";

export type GraphPathSearchLimits = {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxReads: number;
  maxRootsPerRead: number;
  pageSize: number;
  deadlineMs: number;
  maxPaths: number;
};

const DEFAULT_LIMITS: GraphPathSearchLimits = {
  maxDepth: 8,
  maxNodes: 500,
  maxEdges: 1_000,
  maxReads: 32,
  maxRootsPerRead: 25,
  pageSize: 25,
  deadlineMs: 10_000,
  maxPaths: 3,
};

type GraphFrontierPage = {
  nodes: readonly EntityRef[];
  edges: readonly EntityGraphEdge[];
  nextOffset: number | null;
  budgetExceeded?: boolean;
};

export type GraphFrontierReader = (
  roots: readonly EntityRef[],
  offset: number,
  limit: number,
) => Promise<GraphFrontierPage>;

type Trail = EntityGraphPath;
type Visit = { distance: number; trails: Trail[] };
type Side = {
  frontier: EntityRef[];
  depth: number;
  visits: Map<string, Visit>;
};

export type GraphPathSearchResult = {
  paths: EntityGraphPath[];
  edges: EntityGraphEdge[];
  completion: "exhausted" | "depth-limit" | "budget-limit";
  shortestPathCertain: boolean;
};

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
};

const trailKey = (trail: Trail): string =>
  `${trail.nodeRefs.map((ref) => entityRefKey(ref.entityType, ref.entityId)).join(">")}|${trail.edgeIds.join(">")}`;

const recordSequenceKey = (trail: Trail): string =>
  trail.nodeRefs
    .map((ref) => entityRefKey(ref.entityType, ref.entityId))
    .join(">");

const addTrail = (visit: Visit, trail: Trail, maxPaths: number): void => {
  const sequence = recordSequenceKey(trail);
  const existingIndex = visit.trails.findIndex(
    (candidate) => recordSequenceKey(candidate) === sequence,
  );
  if (existingIndex >= 0) {
    const existing = visit.trails[existingIndex];
    if (existing && trailKey(trail).localeCompare(trailKey(existing)) < 0) {
      visit.trails[existingIndex] = trail;
    }
    return;
  }
  if (visit.trails.length < maxPaths) visit.trails.push(trail);
};

const reverseTrail = (trail: Trail): Trail => ({
  nodeRefs: [...trail.nodeRefs].reverse(),
  edgeIds: [...trail.edgeIds].reverse(),
});

const joinedPaths = (
  left: Side,
  right: Side,
  maxPaths: number,
): EntityGraphPath[] => {
  const candidates = new Map<string, EntityGraphPath>();
  let shortest = Number.POSITIVE_INFINITY;
  for (const [key, leftVisit] of left.visits) {
    const rightVisit = right.visits.get(key);
    if (!rightVisit) continue;
    const distance = leftVisit.distance + rightVisit.distance;
    if (distance > shortest) continue;
    if (distance < shortest) {
      shortest = distance;
      candidates.clear();
    }
    for (const leftTrail of leftVisit.trails) {
      for (const destinationTrail of rightVisit.trails) {
        const rightTrail = reverseTrail(destinationTrail);
        const path = {
          nodeRefs: [...leftTrail.nodeRefs, ...rightTrail.nodeRefs.slice(1)],
          edgeIds: [...leftTrail.edgeIds, ...rightTrail.edgeIds],
        };
        const sequence = recordSequenceKey(path);
        const existing = candidates.get(sequence);
        if (!existing || trailKey(path).localeCompare(trailKey(existing)) < 0) {
          candidates.set(sequence, path);
        }
      }
    }
  }
  return [...candidates.values()]
    .sort((leftPath, rightPath) =>
      trailKey(leftPath).localeCompare(trailKey(rightPath)),
    )
    .slice(0, maxPaths);
};

const pathEdges = (
  paths: readonly EntityGraphPath[],
  edges: ReadonlyMap<string, EntityGraphEdge>,
): EntityGraphEdge[] => {
  const pairs = new Set(
    paths.flatMap((path) =>
      path.nodeRefs.slice(1).map((node, index) => {
        const previous = path.nodeRefs[index];
        if (!previous) throw new Error("Path is missing its previous node");
        return [
          entityRefKey(previous.entityType, previous.entityId),
          entityRefKey(node.entityType, node.entityId),
        ]
          .sort()
          .join("|");
      }),
    ),
  );
  return [...edges.values()].filter((edge) =>
    pairs.has(
      [
        entityRefKey(edge.source.entityType, edge.source.entityId),
        entityRefKey(edge.target.entityType, edge.target.entityId),
      ]
        .sort()
        .join("|"),
    ),
  );
};

/**
 * Layer-synchronous bidirectional BFS. The reader is the database seam: it
 * receives bounded root batches and paginates every root's adjacency without
 * exposing query mechanics to the search implementation.
 */
// The budgets, pagination, and two BFS sides must share one state machine so a
// limit cannot be checked after advancing only part of a depth frontier.
// eslint-disable-next-line complexity
export async function searchEntityGraphPaths(
  start: EntityRef,
  destination: EntityRef,
  readFrontier: GraphFrontierReader,
  options: {
    limits?: Partial<GraphPathSearchLimits>;
    now?: () => number;
  } = {},
): Promise<GraphPathSearchResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const deadline = now() + limits.deadlineMs;
  const startKey = entityRefKey(start.entityType, start.entityId);
  const destinationKey = entityRefKey(
    destination.entityType,
    destination.entityId,
  );
  if (startKey === destinationKey) {
    return {
      paths: [{ nodeRefs: [start], edgeIds: [] }],
      edges: [],
      completion: "exhausted",
      shortestPathCertain: true,
    };
  }

  const makeSide = (origin: EntityRef): Side => ({
    frontier: [origin],
    depth: 0,
    visits: new Map([
      [
        entityRefKey(origin.entityType, origin.entityId),
        { distance: 0, trails: [{ nodeRefs: [origin], edgeIds: [] }] },
      ],
    ]),
  });
  const left = makeSide(start);
  const right = makeSide(destination);
  const seenNodes = new Set([startKey, destinationKey]);
  const seenEdges = new Map<string, EntityGraphEdge>();
  let reads = 0;
  let budgetReached = seenNodes.size > limits.maxNodes;

  while (left.frontier.length > 0 && right.frontier.length > 0) {
    if (budgetReached || reads >= limits.maxReads || now() >= deadline) {
      const paths = joinedPaths(left, right, limits.maxPaths);
      return {
        paths,
        edges: pathEdges(paths, seenEdges),
        completion: "budget-limit",
        shortestPathCertain: false,
      };
    }
    const side = left.depth <= right.depth ? left : right;
    const other = side === left ? right : left;
    if (side.depth + other.depth + 1 > limits.maxDepth) {
      return {
        paths: [],
        edges: [],
        completion: "depth-limit",
        shortestPathCertain: false,
      };
    }

    const next = new Map<string, EntityRef>();
    for (const roots of chunks(side.frontier, limits.maxRootsPerRead)) {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        if (reads >= limits.maxReads || now() >= deadline) {
          budgetReached = true;
          break;
        }
        reads += 1;
        const page = await readFrontier(roots, offset, limits.pageSize);
        for (const node of page.nodes) {
          seenNodes.add(entityRefKey(node.entityType, node.entityId));
        }
        for (const edge of page.edges) seenEdges.set(edge.id, edge);
        if (
          page.budgetExceeded ||
          seenNodes.size > limits.maxNodes ||
          seenEdges.size > limits.maxEdges
        ) {
          budgetReached = true;
          break;
        }

        const rootKeys = new Set(
          roots.map((root) => entityRefKey(root.entityType, root.entityId)),
        );
        for (const edge of page.edges) {
          const sourceKey = entityRefKey(
            edge.source.entityType,
            edge.source.entityId,
          );
          const targetKey = entityRefKey(
            edge.target.entityType,
            edge.target.entityId,
          );
          const orientations: [string, EntityRef, EntityRef][] = [];
          if (rootKeys.has(sourceKey)) {
            orientations.push([sourceKey, edge.source, edge.target]);
          }
          if (rootKeys.has(targetKey)) {
            orientations.push([targetKey, edge.target, edge.source]);
          }
          for (const [rootKey, , neighbor] of orientations) {
            const rootVisit = side.visits.get(rootKey);
            if (!rootVisit || rootVisit.distance !== side.depth) continue;
            const neighborKey = entityRefKey(
              neighbor.entityType,
              neighbor.entityId,
            );
            const distance = side.depth + 1;
            let neighborVisit = side.visits.get(neighborKey);
            if (!neighborVisit) {
              neighborVisit = { distance, trails: [] };
              side.visits.set(neighborKey, neighborVisit);
              next.set(neighborKey, neighbor);
            }
            if (neighborVisit.distance !== distance) continue;
            for (const trail of rootVisit.trails) {
              addTrail(
                neighborVisit,
                {
                  nodeRefs: [...trail.nodeRefs, neighbor],
                  edgeIds: [...trail.edgeIds, edge.id],
                },
                limits.maxPaths,
              );
            }
          }
        }
        hasMore = page.nextOffset !== null;
        if (page.nextOffset !== null) offset = page.nextOffset;
      }
      if (budgetReached) break;
    }

    if (budgetReached) {
      const paths = joinedPaths(left, right, limits.maxPaths);
      return {
        paths,
        edges: pathEdges(paths, seenEdges),
        completion: "budget-limit",
        shortestPathCertain: false,
      };
    }
    side.frontier = [...next.values()];
    side.depth += 1;
    const paths = joinedPaths(left, right, limits.maxPaths);
    if (paths.length > 0) {
      return {
        paths,
        edges: pathEdges(paths, seenEdges),
        completion: "exhausted",
        shortestPathCertain: true,
      };
    }
  }

  return {
    paths: [],
    edges: [],
    completion: "exhausted",
    shortestPathCertain: true,
  };
}
