/**
 * Presentation-only graph operations shared by entity dependency viewers.
 * Edges always point from the prerequisite/container to the dependent/member.
 */
interface GraphNode {
  id: string;
  name: string;
  kind?: "project" | "task" | "recipe";
  metadata: string[];
  parentId?: string | null;
  parentName?: string;
  locations?: string[];
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
  workKind?: "all" | "project" | "task";
  direction: "all" | "upstream" | "downstream";
  hideCompleted: boolean;
  hideUnconnected: boolean;
  reduceEdges: boolean;
  grouped: boolean;
  groupByLocation?: boolean;
  location?: string;
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
  if (filters.workKind && filters.workKind !== "all") {
    for (const id of visible.ids) {
      if (nodeById.get(id)?.kind !== filters.workKind) visible.ids.delete(id);
    }
  }
  if (filters.location !== undefined) {
    for (const id of visible.ids) {
      const locations = nodeById.get(id)?.locations ?? [];
      if (
        filters.location === ""
          ? locations.length > 0
          : !locations.includes(filters.location)
      )
        visible.ids.delete(id);
    }
  }
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
  const nodes = allNodes
    .filter((node) => included.has(node.id))
    .map((node) => ({
      ...node,
      parentName: node.parentId ? nodeById.get(node.parentId)?.name : undefined,
    }));
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
      const words = line
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((word) => {
          const characters = [...word];
          return Array.from(
            { length: Math.ceil(characters.length / width) },
            (_, index) =>
              characters.slice(index * width, (index + 1) * width).join(""),
          );
        });
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
  const classes = ["dependency-graph-node", `record-${node.kind ?? "task"}`];
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
  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const title = wrapText(node.name, 32)
    .split("\n")
    .map(escapeHtml)
    .join('<BR ALIGN="LEFT"/>');
  const details = [node.id, ...node.metadata, ...indicators]
    .map((line) => wrapText(line, 38))
    .join("\n")
    .split("\n")
    .map(escapeHtml)
    .join('<BR ALIGN="LEFT"/>');
  return [
    `label=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="2"><TR><TD ALIGN="LEFT"><FONT POINT-SIZE="16"><B>${title}</B></FONT></TD></TR><TR><TD ALIGN="LEFT"><FONT POINT-SIZE="13">${details}</FONT></TD></TR></TABLE>>`,
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
      parent?.name ??
        children[0]?.parentName ??
        children[0]?.metadata[0] ??
        parentId,
      children,
      cycleIds,
      clustered,
    );
  }
  return clustered;
}

function appendLocationGroups(
  lines: string[],
  prepared: PreparedGraph,
  cycleIds: Set<string>,
  grouped: boolean,
): Set<string> {
  const groups = new Map<string, { label: string; nodes: GraphNode[] }>();
  for (const node of prepared.nodes) {
    const locations = [...new Set(node.locations ?? [])].sort();
    const key = JSON.stringify(locations);
    const group = groups.get(key) ?? {
      label: locations.join(" / ") || "No location",
      nodes: [],
    };
    group.nodes.push(node);
    groups.set(key, group);
  }
  const clustered = new Set<string>();
  for (const [key, group] of groups) {
    lines.push(`subgraph ${quote(`cluster:location:${key}`)} {`);
    lines.push(`label=${quote(group.label)}; class="dependency-graph-group";`);
    const hierarchyLines: string[] = [];
    const hierarchyNodes = appendGroups(
      hierarchyLines,
      { ...prepared, nodes: group.nodes },
      grouped,
      cycleIds,
    );
    // A parent can have children in multiple locations; each cluster needs its own ID.
    lines.push(
      ...hierarchyLines.map((line) =>
        line.replace(
          'subgraph "cluster:',
          `subgraph "cluster:location:${encodeURIComponent(key)}:`,
        ),
      ),
    );
    for (const node of group.nodes) {
      if (!hierarchyNodes.has(node.id))
        lines.push(`${quote(node.id)} [${nodeAttributes(node, cycleIds)}];`);
      clustered.add(node.id);
    }
    lines.push("}");
  }
  return clustered;
}

/** Keep selected groups together even when their parent is outside the visible graph. */
function connectedComponents(
  prepared: PreparedGraph,
  grouped: boolean,
): PreparedGraph[] {
  const neighbors = new Map(
    prepared.nodes.map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of prepared.edges) {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }
  if (grouped) {
    const firstChild = new Map<string, string>();
    for (const node of prepared.nodes) {
      if (node.parentId == null || node.kind !== "task") continue;
      const sibling = firstChild.get(node.parentId);
      if (sibling == null) firstChild.set(node.parentId, node.id);
      else {
        neighbors.get(sibling)?.add(node.id);
        neighbors.get(node.id)?.add(sibling);
      }
    }
  }
  const unseen = new Set(neighbors.keys());
  const components: PreparedGraph[] = [];
  for (const start of unseen) {
    const ids = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop();
      if (id == null || !unseen.delete(id)) continue;
      ids.add(id);
      pending.push(...(neighbors.get(id) ?? []));
    }
    components.push({
      ...prepared,
      nodes: prepared.nodes.filter((node) => ids.has(node.id)),
      edges: prepared.edges.filter((edge) => ids.has(edge.source)),
    });
  }
  return components;
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

/** Leaf siblings have no ordering relationship; invisible chains pack wide fans into rows. */
function leafSiblingGroups(graph: PreparedGraph, groupByLocation: boolean) {
  const constrained = new Set(
    graph.edges.flatMap((edge) =>
      edge.kind === "dependency" ? [edge.source, edge.target] : [edge.source],
    ),
  );
  const siblings = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (constrained.has(node.id)) continue;
    const key = JSON.stringify([
      node.parentId ?? null,
      groupByLocation ? [...new Set(node.locations ?? [])].sort() : null,
    ]);
    const group = siblings.get(key) ?? [];
    group.push(node);
    siblings.set(key, group);
  }
  return [...siblings.values()];
}

function appendSiblingLayout(
  lines: string[],
  graph: PreparedGraph,
  groupByLocation: boolean,
) {
  for (const nodes of leafSiblingGroups(graph, groupByLocation)) {
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length / 2)));
    for (let index = 1; index < nodes.length; index++) {
      if (index % columns !== 0)
        lines.push(
          `${quote(nodes[index - 1]!.id)} -> ${quote(nodes[index]!.id)} [style=invis];`,
        );
    }
  }
}

/** Serializes a prepared graph to safe, deterministic Graphviz DOT. */
export function graphToDot(
  prepared: PreparedGraph,
  grouped: boolean,
  groupByLocation = false,
  overlayTargets: ReadonlySet<string> = new Set(),
): string {
  const cycleIds = new Set(prepared.cycleIds);
  const components = groupByLocation
    ? [prepared]
    : connectedComponents(prepared, grouped);
  const packing = groupByLocation
    ? "array"
    : `array${Math.max(1, Math.ceil(Math.sqrt(components.length * 2)))}`;
  const lines = [
    "digraph dependency_graph {",
    `graph [rankdir=LR, pack=24, packmode="${packing}", fontname="Arial", fontsize=12];`,
    'node [shape=box, fontname="Arial", fontsize=12, margin="0.25,0.15"];',
    'edge [class="dependency-graph-edge", fontname="Arial", fontsize=12];',
  ];
  for (const [index, component] of components.entries()) {
    lines.push(`subgraph "component${index}" {`);
    // Cluster IDs must be unique when a cookbook spans disconnected components.
    const componentLines: string[] = [];
    const clustered = groupByLocation
      ? appendLocationGroups(componentLines, component, cycleIds, grouped)
      : appendGroups(componentLines, component, grouped, cycleIds);
    lines.push(
      ...componentLines.map((line) =>
        line.replace('subgraph "cluster:', `subgraph "cluster:${index}:`),
      ),
    );
    for (const node of component.nodes) {
      if (!clustered.has(node.id))
        lines.push(`${quote(node.id)} [${nodeAttributes(node, cycleIds)}];`);
    }
    appendSiblingLayout(lines, component, groupByLocation);
    for (const edge of component.edges) {
      if (edge.kind === "hierarchy" && overlayTargets.has(edge.target))
        continue;
      lines.push(
        `${quote(edge.source)} -> ${quote(edge.target)} [${edgeAttributes(edge)}];`,
      );
    }
    lines.push("}");
  }
  lines.push("}");
  return lines.join("\n");
}

/** Route repeated fan-out links after placement so they cannot stretch sibling rows. */
export function layoutGraph(
  prepared: PreparedGraph,
  grouped: boolean,
  groupByLocation = false,
) {
  const targets = new Set<string>();
  for (const nodes of leafSiblingGroups(prepared, groupByLocation)) {
    if (nodes.length < 8) continue;
    const columns = Math.ceil(Math.sqrt(nodes.length / 2));
    nodes.forEach((node, index) => {
      if (index % columns !== 0) targets.add(node.id);
    });
  }
  return {
    dot: graphToDot(prepared, grouped, groupByLocation, targets),
    hierarchyEdges: prepared.edges.filter(
      (edge) => edge.kind === "hierarchy" && targets.has(edge.target),
    ),
  };
}
