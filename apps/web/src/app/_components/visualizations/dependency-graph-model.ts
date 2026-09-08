/**
 * Presentation-only graph operations shared by entity dependency viewers.
 * Edges always point from the prerequisite/container to the dependent/member.
 */
interface GraphNode {
  id: string;
  name: string;
  metadata: string[];
  parentId?: string | null;
  completed?: boolean;
  overdue?: boolean;
  external?: boolean;
  href: string;
}

interface GraphEdge {
  source: string;
  target: string;
  kind: "hierarchy" | "dependency";
  /** Optional domain vocabulary, for example recipe dependency edges use "uses". */
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilters {
  focus?: string;
  direction: "all" | "upstream" | "downstream";
  hideCompleted: boolean;
  hideUnconnected: boolean;
  reduceEdges: boolean;
  grouped: boolean;
}

export interface PreparedGraph extends GraphData {
  /** Nodes which participate in a dependency cycle, including self-loops. */
  cycleIds: string[];
  hiddenNodeCount: number;
  removedEdgeCount: number;
  /** Stable dependency levels. Nodes in a cycle intentionally share a level. */
  levels: Record<string, number>;
}

const edgeKey = (edge: GraphEdge) =>
  `${edge.kind}\u0000${edge.source}\u0000${edge.target}`;

function graphEdges(data: GraphData, nodeIds: Set<string>): GraphEdge[] {
  const seen = new Set<string>();
  return data.edges.filter((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
    const key = edgeKey(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dependencyReachable(
  edges: readonly GraphEdge[],
  start: string,
  direction: GraphFilters["direction"],
): Set<string> {
  const included = new Set([start]);
  // "Both directions" is the union of each directed traversal. A single
  // undirected walk would incorrectly zig-zag from an upstream blocker into a
  // different downstream branch.
  if (direction === "all") {
    for (const id of dependencyReachable(edges, start, "upstream"))
      included.add(id);
    for (const id of dependencyReachable(edges, start, "downstream"))
      included.add(id);
    return included;
  }
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== "dependency") continue;
    const from = direction === "upstream" ? edge.target : edge.source;
    const to = direction === "upstream" ? edge.source : edge.target;
    const values = next.get(from) ?? [];
    values.push(to);
    next.set(from, values);
  }
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) continue;
    for (const id of next.get(current) ?? []) {
      if (!included.has(id)) {
        included.add(id);
        pending.push(id);
      }
    }
  }
  return included;
}

function withAncestors(
  ids: ReadonlySet<string>,
  nodeById: Map<string, GraphNode>,
) {
  const result = new Set(ids);
  const pending = Array.from(result);
  while (pending.length > 0) {
    const id = pending.pop();
    if (id == null) continue;
    const parentId = nodeById.get(id)?.parentId;
    if (parentId != null && nodeById.has(parentId) && !result.has(parentId)) {
      result.add(parentId);
      pending.push(parentId);
    }
  }
  return result;
}

/** Tarjan's algorithm, with input order preserved for reproducible DOT. */
function stronglyConnectedComponents(
  ids: string[],
  edges: readonly GraphEdge[],
) {
  const outgoing = new Map<string, string[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const edge of edges) {
    if (edge.kind === "dependency")
      outgoing.get(edge.source)?.push(edge.target);
  }
  let index = 0;
  const indexById = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string) => {
    indexById.set(id, index);
    lowlink.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!indexById.has(target)) {
        visit(target);
        lowlink.set(
          id,
          Math.min(lowlink.get(id) ?? 0, lowlink.get(target) ?? 0),
        );
      } else if (onStack.has(target)) {
        lowlink.set(
          id,
          Math.min(lowlink.get(id) ?? 0, indexById.get(target) ?? 0),
        );
      }
    }
    if (lowlink.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member == null) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    components.push(component.reverse());
  };
  for (const id of ids) if (!indexById.has(id)) visit(id);
  return components;
}

function dependencyAnalysis(nodes: GraphNode[], edges: readonly GraphEdge[]) {
  const components = stronglyConnectedComponents(
    nodes.map((node) => node.id),
    edges,
  );
  const componentById = new Map<string, number>();
  components.forEach((component, index) => {
    component.forEach((id) => componentById.set(id, index));
  });
  const selfLoops = new Set(
    edges
      .filter(
        (edge) => edge.kind === "dependency" && edge.source === edge.target,
      )
      .map((edge) => edge.source),
  );
  const cycleIds = components
    .filter(
      (component) => component.length > 1 || selfLoops.has(component[0] ?? ""),
    )
    .flat();
  const cyclic = new Set(cycleIds);
  const successors = new Map<number, Set<number>>();
  const indegree = new Map<number, number>();
  components.forEach((_, index) => indegree.set(index, 0));
  for (const edge of edges) {
    if (edge.kind !== "dependency") continue;
    const source = componentById.get(edge.source);
    const target = componentById.get(edge.target);
    if (source == null || target == null || source === target) continue;
    const values = successors.get(source) ?? new Set<number>();
    if (!values.has(target)) {
      values.add(target);
      successors.set(source, values);
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
  }
  const queue = components
    .map((_, index) => index)
    .filter((index) => indegree.get(index) === 0);
  const componentLevels = new Map<number, number>(queue.map((id) => [id, 0]));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current == null) continue;
    const level = componentLevels.get(current) ?? 0;
    for (const target of successors.get(current) ?? []) {
      componentLevels.set(
        target,
        Math.max(componentLevels.get(target) ?? 0, level + 1),
      );
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  const levels: Record<string, number> = {};
  components.forEach((component, index) => {
    for (const id of component) levels[id] = componentLevels.get(index) ?? 0;
  });
  return { cycleIds, cyclic, levels };
}

interface ReducedEdges {
  edges: GraphEdge[];
  removed: number;
}

interface CompletedVisibility {
  ids: Set<string>;
  contextIds: Set<string>;
}

function removeRedundantDependencies(
  edges: GraphEdge[],
  cyclic: Set<string>,
): ReducedEdges {
  const dependencies = edges.filter((edge) => edge.kind === "dependency");
  const removable = new Set<string>();
  for (const candidate of dependencies) {
    if (cyclic.has(candidate.source) || cyclic.has(candidate.target)) continue;
    const pending = [candidate.source];
    const visited = new Set([candidate.source]);
    let found = false;
    while (pending.length > 0 && !found) {
      const current = pending.pop();
      if (current == null) continue;
      for (const edge of dependencies) {
        if (
          edge === candidate ||
          edge.source !== current ||
          cyclic.has(edge.target)
        )
          continue;
        if (edge.target === candidate.target) {
          found = true;
          break;
        }
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          pending.push(edge.target);
        }
      }
    }
    if (found) removable.add(edgeKey(candidate));
  }
  return {
    edges: edges.filter((edge) => !removable.has(edgeKey(edge))),
    removed: removable.size,
  };
}

function selectedNodeIds(
  allIds: Set<string>,
  edges: GraphEdge[],
  filters: GraphFilters,
  nodeById: Map<string, GraphNode>,
): Set<string> {
  if (filters.focus == null || !nodeById.has(filters.focus)) return allIds;
  return withAncestors(
    dependencyReachable(edges, filters.focus, filters.direction),
    nodeById,
  );
}

function completedVisibility(
  ids: Set<string>,
  nodeById: Map<string, GraphNode>,
  filters: GraphFilters,
): CompletedVisibility {
  if (!filters.hideCompleted) return { ids, contextIds: new Set() };
  const roots = new Set(
    [...ids].filter(
      (id) => !nodeById.get(id)?.completed || id === filters.focus,
    ),
  );
  const visible = withAncestors(roots, nodeById);
  return {
    ids: visible,
    contextIds: new Set(
      [...visible].filter((id) => nodeById.get(id)?.completed),
    ),
  };
}

function withoutUnconnected(
  ids: Set<string>,
  edges: GraphEdge[],
  filters: GraphFilters,
  contextIds: Set<string>,
): Set<string> {
  if (!filters.hideUnconnected) return ids;
  const connected = new Set(contextIds);
  for (const edge of edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  if (filters.focus != null && ids.has(filters.focus))
    connected.add(filters.focus);
  return connected;
}

export function prepareGraph(
  data: GraphData,
  filters: GraphFilters,
): PreparedGraph {
  const nodeById = new Map<string, GraphNode>();
  for (const node of data.nodes)
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  const allNodes = [...nodeById.values()];
  const allIds = new Set(nodeById.keys());
  const allEdges = graphEdges(data, allIds);
  const selected = selectedNodeIds(allIds, allEdges, filters, nodeById);
  const visible = completedVisibility(selected, nodeById, filters);
  const initialEdges = graphEdges(
    { nodes: allNodes, edges: allEdges },
    visible.ids,
  );
  const included = withoutUnconnected(
    visible.ids,
    initialEdges,
    filters,
    visible.contextIds,
  );
  const edges = graphEdges({ nodes: allNodes, edges: initialEdges }, included);
  const nodes = allNodes.filter((node) => included.has(node.id));
  const analysis = dependencyAnalysis(nodes, edges);
  const reduced = filters.reduceEdges
    ? removeRedundantDependencies(edges, analysis.cyclic)
    : { edges, removed: 0 };
  return {
    nodes,
    edges: reduced.edges,
    cycleIds: analysis.cycleIds,
    hiddenNodeCount: allNodes.length - nodes.length,
    removedEdgeCount: reduced.removed,
    levels: analysis.levels,
  };
}

function quote(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

function wrapText(value: string, width = 40): string {
  return value
    .split(/\r?\n/)
    .flatMap((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current.length > 0 && current.length + word.length + 1 > width) {
          lines.push(current);
          current = word;
        } else {
          current = current.length === 0 ? word : `${current} ${word}`;
        }
      }
      if (current.length > 0) lines.push(current);
      return lines.length === 0 ? [""] : lines;
    })
    .join("\n");
}

function nodeAttributes(node: GraphNode, cycleIds: Set<string>) {
  const classes = ["dependency-graph-node"];
  if (node.completed)
    classes.push("completed", "dependency-graph-node--completed");
  if (node.overdue) classes.push("overdue", "dependency-graph-node--overdue");
  if (node.external)
    classes.push("external", "dependency-graph-node--external");
  if (cycleIds.has(node.id))
    classes.push("cycle", "dependency-graph-node--cycle");
  const indicators = [
    node.overdue ? "Overdue" : null,
    node.external ? "Outside scope" : null,
    cycleIds.has(node.id) ? "Cycle" : null,
  ].filter((indicator): indicator is string => indicator != null);
  const label = [node.name, node.id, ...node.metadata, ...indicators]
    .map((line) => wrapText(line))
    .join("\n");
  return [
    `label=${quote(label)}`,
    `URL=${quote(node.href)}`,
    `tooltip=${quote([node.name, ...node.metadata].join(" — "))}`,
    `class=${quote(classes.join(" "))}`,
  ].join(", ");
}

function appendGroup(
  lines: string[],
  groupId: string,
  label: string,
  children: GraphNode[],
  cycleIds: Set<string>,
  clustered: Set<string>,
) {
  lines.push(`subgraph ${quote(`cluster:${groupId}`)} {`);
  lines.push(`label=${quote(label)}; class="dependency-graph-group";`);
  for (const child of children) {
    lines.push(`${quote(child.id)} [${nodeAttributes(child, cycleIds)}];`);
    clustered.add(child.id);
  }
  lines.push("}");
}

function appendGroups(
  lines: string[],
  prepared: PreparedGraph,
  grouped: boolean,
  cycleIds: Set<string>,
): Set<string> {
  const clustered = new Set<string>();
  if (!grouped) return clustered;
  const byParent = new Map<string, GraphNode[]>();
  for (const node of prepared.nodes) {
    if (node.parentId == null) continue;
    const children = byParent.get(node.parentId) ?? [];
    children.push(node);
    byParent.set(node.parentId, children);
  }
  const nodeById = new Map(prepared.nodes.map((node) => [node.id, node]));
  for (const [parentId, children] of byParent) {
    const parent = nodeById.get(parentId);
    appendGroup(
      lines,
      parentId,
      parent?.name ?? children[0]?.metadata[0] ?? parentId,
      children,
      cycleIds,
      clustered,
    );
  }
  return clustered;
}

function appendRankLines(lines: string[], prepared: PreparedGraph) {
  const dependencyIds = new Set(
    prepared.edges
      .filter((edge) => edge.kind === "dependency")
      .flatMap((edge) => [edge.source, edge.target]),
  );
  const byLevel = new Map<number, string[]>();
  for (const node of prepared.nodes) {
    if (!dependencyIds.has(node.id)) continue;
    const level = prepared.levels[node.id] ?? 0;
    const ids = byLevel.get(level) ?? [];
    ids.push(quote(node.id));
    byLevel.set(level, ids);
  }
  for (const [, ids] of [...byLevel.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`{ rank=same; ${ids.join("; ")}; }`);
  }
}

function edgeAttributes(edge: GraphEdge): string {
  if (edge.kind === "hierarchy") {
    return 'class="dependency-graph-edge dependency-graph-edge--hierarchy", style=dotted, arrowhead=none';
  }
  return [
    'class="dependency-graph-edge dependency-graph-edge--dependency"',
    "style=solid",
    edge.label == null ? null : `label=${quote(edge.label)}`,
  ]
    .filter((attribute): attribute is string => attribute != null)
    .join(", ");
}

/** Serializes a prepared graph to safe, deterministic Graphviz DOT. */
export function graphToDot(prepared: PreparedGraph, grouped: boolean): string {
  const cycleIds = new Set(prepared.cycleIds);
  const lines = [
    "digraph dependency_graph {",
    'graph [rankdir=LR, newrank=true, fontname="Inter", fontsize=12];',
    'node [shape=box, fontname="Inter", fontsize=12, margin="0.25,0.15"];',
    'edge [class="dependency-graph-edge", fontname="Inter", fontsize=12];',
  ];
  const clustered = appendGroups(lines, prepared, grouped, cycleIds);
  for (const node of prepared.nodes) {
    if (!clustered.has(node.id))
      lines.push(`${quote(node.id)} [${nodeAttributes(node, cycleIds)}];`);
  }
  appendRankLines(lines, prepared);
  for (const edge of prepared.edges) {
    lines.push(
      `${quote(edge.source)} -> ${quote(edge.target)} [${edgeAttributes(edge)}];`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}
