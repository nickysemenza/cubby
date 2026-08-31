/**
 * Return one stable, closed cycle path per cyclic strongly-connected component.
 * Dependency writes only need to know whether the result is empty; Problems
 * keeps the paths so an out-of-band corruption remains diagnosable.
 */
export function findDirectedDependencyCycles<T extends string>(
  edges: readonly { from: T; to: T }[],
): T[][] {
  const adjacency = new Map<T, T[]>();
  for (const { from, to } of edges) {
    const neighbors = adjacency.get(from) ?? [];
    if (!neighbors.includes(to)) neighbors.push(to);
    adjacency.set(from, neighbors);
    if (!adjacency.has(to)) adjacency.set(to, []);
  }
  for (const neighbors of adjacency.values()) neighbors.sort();

  let nextIndex = 0;
  const indexByNode = new Map<T, number>();
  const lowLinkByNode = new Map<T, number>();
  const stack: T[] = [];
  const onStack = new Set<T>();
  const components: T[][] = [];

  const visit = (node: T): void => {
    const index = nextIndex++;
    indexByNode.set(node, index);
    lowLinkByNode.set(node, index);
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!indexByNode.has(neighbor)) {
        visit(neighbor);
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node)!, lowLinkByNode.get(neighbor)!),
        );
      } else if (onStack.has(neighbor)) {
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node)!, indexByNode.get(neighbor)!),
        );
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) return;
    const component: T[] = [];
    let popped: T;
    do {
      popped = stack.pop()!;
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== node);
    component.sort();
    if (
      component.length > 1 ||
      (adjacency.get(component[0]!) ?? []).includes(component[0]!)
    ) {
      components.push(component);
    }
  };

  for (const node of [...adjacency.keys()].sort()) {
    if (!indexByNode.has(node)) visit(node);
  }

  const cycleWithin = (component: readonly T[]): T[] => {
    const members = new Set(component);
    const activeIndex = new Map<T, number>();
    const visited = new Set<T>();
    const path: T[] = [];

    const walk = (node: T): T[] | null => {
      visited.add(node);
      activeIndex.set(node, path.length);
      path.push(node);
      for (const neighbor of adjacency.get(node) ?? []) {
        if (!members.has(neighbor)) continue;
        const prior = activeIndex.get(neighbor);
        if (prior !== undefined) return [...path.slice(prior), neighbor];
        if (!visited.has(neighbor)) {
          const cycle = walk(neighbor);
          if (cycle) return cycle;
        }
      }
      path.pop();
      activeIndex.delete(node);
      return null;
    };

    for (const node of component) {
      const cycle = visited.has(node) ? null : walk(node);
      if (cycle) return cycle;
    }
    throw new Error("A cyclic dependency component had no cycle path.");
  };

  return components
    .map(cycleWithin)
    .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}
