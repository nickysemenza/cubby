import type { EntityRef } from "@cubby/schemas/entity";
import {
  entityGraphRootSchema,
  type EntityGraphOutput,
} from "@cubby/schemas/entity-graph";

import {
  graphBranchKey,
  graphRefKey,
  GRAPH_BRANCH_PAGE_SIZE,
} from "./entity-graph-state";

export const parseGraphRecord = (key?: string) => {
  const separator = key?.indexOf(":") ?? -1;
  return entityGraphRootSchema.safeParse({
    entityType: key?.slice(0, separator),
    entityId: key?.slice(separator + 1),
  }).data;
};

export function graphBranchCount(
  branch: EntityGraphOutput["branches"][number],
  counts: ReadonlyMap<string, number>,
) {
  return Math.min(
    branch.items.length,
    counts.get(graphBranchKey(branch.root, branch.relationshipKey)) ??
      // The first fetched page is useful even when the branch has another
      // page. Expansion remains explicit through the stored visible count.
      Math.min(branch.items.length, GRAPH_BRANCH_PAGE_SIZE),
  );
}

/** Edge ownership matters: collapsing one branch cannot hide another branch's shared edge. */
export function projectGraphMap(
  data: EntityGraphOutput,
  root: EntityRef,
  counts: ReadonlyMap<string, number>,
  pathEdges: ReadonlySet<string> = new Set(),
) {
  const allowed = new Set(pathEdges);
  const anchors = new Map<string, string>();
  const edgesByID = new Map(data.edges.map((edge) => [edge.id, edge]));
  for (const branch of data.branches) {
    const members = new Set(
      branch.items.slice(0, graphBranchCount(branch, counts)).map(graphRefKey),
    );
    for (const key of members)
      if (!anchors.has(key)) anchors.set(key, graphRefKey(branch.root));
    for (const id of branch.edgeIds) {
      const edge = edgesByID.get(id);
      if (
        edge &&
        (members.has(graphRefKey(edge.source)) ||
          members.has(graphRefKey(edge.target)))
      )
        allowed.add(edge.id);
    }
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of data.edges) {
    if (!allowed.has(edge.id)) continue;
    const source = graphRefKey(edge.source);
    const target = graphRefKey(edge.target);
    adjacency.set(source, [...(adjacency.get(source) ?? []), target]);
    adjacency.set(target, [...(adjacency.get(target) ?? []), source]);
  }
  const visible = new Set([graphRefKey(root)]);
  const queue = [...visible];
  for (const key of queue) {
    for (const next of adjacency.get(key) ?? []) {
      if (!visible.has(next)) {
        visible.add(next);
        queue.push(next);
      }
    }
  }
  return {
    nodes: data.nodes.filter((node) => visible.has(graphRefKey(node))),
    edges: data.edges.filter(
      (edge) =>
        allowed.has(edge.id) &&
        visible.has(graphRefKey(edge.source)) &&
        visible.has(graphRefKey(edge.target)),
    ),
    anchors,
  };
}
