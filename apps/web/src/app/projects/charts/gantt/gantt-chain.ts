/**
 * Critical-chain detection over a dependency graph (`blockedByIds` edges).
 * Pure graph math — no cubby/DB types — shared by the portfolio and
 * project-detail Gantt surfaces to highlight the longest duration-weighted
 * path per weakly-connected component.
 *
 * Edge direction is blocker -> blocked: node `N.blockedByIds` lists the ids
 * of nodes that block `N`, so each entry becomes an edge `(blockerId, N.id)`.
 * A "longest chain" walks forward along that direction, summing durations.
 */

export interface ChainNode {
  id: string;
  startDay: number | null;
  endDay: number | null;
  blockedByIds: readonly string[];
}

export interface ChainResult {
  ids: string[];
  edges: Array<[string, string]>;
  /** Sum of each node's own duration along the chain. */
  workDays: number;
  /**
   * `maxEndDay - minStartDay + 1` across the chain's dated nodes, or equal to
   * `workDays` when none are dated. Can be *less* than `workDays` when
   * dependencies overlap in time — that's real signal, never clamped.
   */
  elapsedDays: number;
}

function durationOf(node: ChainNode | undefined): number {
  if (node == null || node.startDay == null || node.endDay == null) return 1;
  return Math.max(1, node.endDay - node.startDay + 1);
}

/** BFS over the undirected view of the edges to find weakly-connected components. */
function findComponents(
  ids: readonly string[],
  undirected: Map<string, string[]>,
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [start];
    const component: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current == null) continue;
      component.push(current);
      for (const neighbor of undirected.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components;
}

type Color = "white" | "gray" | "black";

/**
 * Memoized DFS over the directed (blocker -> blocked) edges restricted to one
 * component, with a tri-color cycle guard: revisiting a `gray` (in-progress)
 * node means a cycle, and that branch simply contributes 0 rather than
 * recursing forever or throwing.
 */
function longestPathInComponent(
  componentIds: string[],
  outEdges: Map<string, string[]>,
  getDuration: (id: string) => number,
): { ids: string[]; edges: Array<[string, string]>; workDays: number } | null {
  const color = new Map<string, Color>(componentIds.map((id) => [id, "white"]));
  const best = new Map<string, number>();
  const bestNext = new Map<string, string | null>();

  function visit(id: string): number {
    const c = color.get(id) ?? "white";
    if (c === "black") return best.get(id) ?? 0;
    if (c === "gray") return 0; // cycle revisit — contributes nothing

    color.set(id, "gray");
    let bestSuccessorValue = 0;
    let bestSuccessor: string | null = null;
    for (const successor of outEdges.get(id) ?? []) {
      const value = visit(successor);
      if (value > bestSuccessorValue) {
        bestSuccessorValue = value;
        bestSuccessor = successor;
      }
    }
    const total = getDuration(id) + bestSuccessorValue;
    best.set(id, total);
    bestNext.set(id, bestSuccessor);
    color.set(id, "black");
    return total;
  }

  for (const id of componentIds) {
    if ((color.get(id) ?? "white") === "white") visit(id);
  }

  let bestStart: string | null = null;
  let bestTotal = -Infinity;
  for (const id of componentIds) {
    const total = best.get(id) ?? 0;
    if (total > bestTotal) {
      bestTotal = total;
      bestStart = id;
    }
  }
  if (bestStart == null) return null;

  const ids: string[] = [];
  const edges: Array<[string, string]> = [];
  let current: string | null = bestStart;
  while (current != null) {
    const currentId: string = current;
    ids.push(currentId);
    const next: string | null = bestNext.get(currentId) ?? null;
    if (next != null) edges.push([currentId, next]);
    current = next;
  }
  return { ids, edges, workDays: bestTotal };
}

/**
 * Splits `nodes` into weakly-connected dependency components and finds each
 * component's duration-weighted longest path (its "critical chain"). Returns
 * components sorted by `workDays` descending; singleton components with no
 * edges are dropped (a lone node isn't a chain).
 */
export function longestChains(nodes: ChainNode[]): ChainResult[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, string[]>();
  const undirected = new Map<string, string[]>();
  for (const n of nodes) {
    outEdges.set(n.id, []);
    undirected.set(n.id, []);
  }
  for (const n of nodes) {
    for (const blockerId of n.blockedByIds) {
      if (!nodeById.has(blockerId)) continue; // edge to a node outside this set — skip
      outEdges.get(blockerId)?.push(n.id);
      undirected.get(blockerId)?.push(n.id);
      undirected.get(n.id)?.push(blockerId);
    }
  }

  const ids = nodes.map((n) => n.id);
  const components = findComponents(ids, undirected).filter(
    (c) => c.length > 1,
  );

  const results: ChainResult[] = [];
  for (const componentIds of components) {
    const path = longestPathInComponent(componentIds, outEdges, (id) =>
      durationOf(nodeById.get(id)),
    );
    if (path == null) continue;

    const datedIds = path.ids.filter((id) => {
      const node = nodeById.get(id);
      return node != null && node.startDay != null && node.endDay != null;
    });

    let elapsedDays = path.workDays;
    if (datedIds.length > 0) {
      let minStart = Infinity;
      let maxEnd = -Infinity;
      for (const id of datedIds) {
        const node = nodeById.get(id);
        if (node?.startDay == null || node.endDay == null) continue;
        if (node.startDay < minStart) minStart = node.startDay;
        if (node.endDay > maxEnd) maxEnd = node.endDay;
      }
      elapsedDays = maxEnd - minStart + 1;
    }

    results.push({
      ids: path.ids,
      edges: path.edges,
      workDays: path.workDays,
      elapsedDays,
    });
  }

  results.sort((a, b) => b.workDays - a.workDays);
  return results;
}
