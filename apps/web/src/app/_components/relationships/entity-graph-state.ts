import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphEdge,
  EntityGraphOutput,
} from "@cubby/schemas/entity-graph";

export const GRAPH_NODE_LIMIT = 500;
export const GRAPH_EDGE_LIMIT = 1_000;
export const GRAPH_BRANCH_PAGE_SIZE = 12;
export const GRAPH_NEIGHBOR_LIMIT = 60;
export const GRAPH_VISIT_LIMIT = 32;
export const graphRefKey = (ref: EntityRef) =>
  entityRefKey(ref.entityType, ref.entityId);
export const graphBranchKey = (root: EntityRef, relationshipKey: string) =>
  `${graphRefKey(root)}:${relationshipKey}`;

export interface GraphVisitHistory {
  trail: string[];
  cursor: number;
}

/** Browser-like history: repeated visits matter and a new choice drops forward history. */
export function visitGraphRecord(
  history: GraphVisitHistory,
  key: string,
): GraphVisitHistory {
  const trail = [...history.trail.slice(0, history.cursor + 1), key].slice(
    -GRAPH_VISIT_LIMIT,
  );
  return { trail, cursor: trail.length - 1 };
}

export function moveGraphVisit(
  history: GraphVisitHistory,
  offset: -1 | 1,
): GraphVisitHistory {
  return {
    ...history,
    cursor: Math.max(
      0,
      Math.min(history.trail.length - 1, history.cursor + offset),
    ),
  };
}

/**
 * Allocate neighborhood space round-robin in manifest branch order. Shared
 * records consume one slot and stay available through every branch that names them.
 */
export function visibleNeighborhoodKeys(
  branches: readonly EntityGraphOutput["branches"][number][],
  visibleCounts: ReadonlyMap<string, number>,
  limit = GRAPH_NEIGHBOR_LIMIT,
): Set<string> {
  const result = new Set<string>();
  const queues = branches.map((branch) =>
    branch.items.slice(
      0,
      visibleCounts.get(graphBranchKey(branch.root, branch.relationshipKey)) ??
        GRAPH_BRANCH_PAGE_SIZE,
    ),
  );
  for (let index = 0; result.size < limit; index++) {
    let found = false;
    for (const queue of queues) {
      const ref = queue[index];
      if (!ref) continue;
      found = true;
      result.add(graphRefKey(ref));
      if (result.size === limit) break;
    }
    if (!found) break;
  }
  return result;
}

/** Merge expansion pages without turning shared records into duplicate nodes. */
export function mergeGraphPages(
  pages: readonly EntityGraphOutput[],
): EntityGraphOutput {
  const nodes = new Map<string, EntityGraphOutput["nodes"][number]>();
  const edges = new Map<string, EntityGraphEdge>();
  const branches = new Map<string, EntityGraphOutput["branches"][number]>();
  let truncated = false;
  for (const page of pages) {
    truncated ||= page.truncated;
    for (const node of page.nodes) {
      const key = graphRefKey(node);
      if (nodes.has(key) || nodes.size < GRAPH_NODE_LIMIT) nodes.set(key, node);
      else truncated = true;
    }
    for (const edge of page.edges) {
      if (edges.has(edge.id) || edges.size < GRAPH_EDGE_LIMIT)
        edges.set(edge.id, edge);
      else truncated = true;
    }
    for (const branch of page.branches) {
      const key = graphBranchKey(branch.root, branch.relationshipKey);
      const previous = branches.get(key);
      const items = new Map(
        [...(previous?.items ?? []), ...branch.items].map((ref) => [
          graphRefKey(ref),
          ref,
        ]),
      );
      branches.set(key, {
        ...branch,
        items: [...items.values()],
        edgeIds: [
          ...new Set([...(previous?.edgeIds ?? []), ...branch.edgeIds]),
        ],
      });
    }
  }
  const retainedEdges = [...edges.values()].filter(
    (edge) =>
      nodes.has(graphRefKey(edge.source)) &&
      nodes.has(graphRefKey(edge.target)),
  );
  const retainedEdgeIds = new Set(retainedEdges.map((edge) => edge.id));
  return {
    nodes: [...nodes.values()],
    edges: retainedEdges,
    branches: [...branches.values()]
      .filter((branch) => nodes.has(graphRefKey(branch.root)))
      .map((branch) => ({
        ...branch,
        items: branch.items.filter((ref) => nodes.has(graphRefKey(ref))),
        edgeIds: branch.edgeIds.filter((id) => retainedEdgeIds.has(id)),
      })),
    truncated,
  };
}

/** Walk only new records; cycles and converging paths never enqueue twice. */
export function nextGraphFrontier(
  data: EntityGraphOutput,
  expanded: ReadonlySet<string>,
): EntityRef[] {
  return data.nodes
    .filter((node) => !expanded.has(graphRefKey(node)))
    .map(({ entityType, entityId }) => ({ entityType, entityId }));
}

/** Advance through already-loaded paths to the next unexpanded frontier. */
export function graphExpansionFrontier(
  data: EntityGraphOutput,
  selected: EntityRef,
  expanded: ReadonlySet<string>,
): EntityRef[] {
  const pending: EntityRef[] = [selected];
  const seen = new Set<string>();
  const frontier: EntityRef[] = [];
  const branches = new Map<string, EntityRef[]>();
  for (const branch of data.branches) {
    const key = graphRefKey(branch.root);
    branches.set(key, [...(branches.get(key) ?? []), ...branch.items]);
  }
  for (const ref of pending) {
    const key = graphRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!expanded.has(key)) frontier.push(ref);
    else pending.push(...(branches.get(key) ?? []));
  }
  return frontier;
}
