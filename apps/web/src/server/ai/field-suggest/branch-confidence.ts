/**
 * Hierarchy-aware placement for a reference suggestion over a tree roster
 * (product categories). Jev spreads probability across every node, so a
 * parent and its children, or sibling leaves, split the mass: "Food 0.10,
 * Food › Prepared 0.70, Food › Snacks 0.08" is a confident "Food" but a
 * medium leaf. Summing each node's subtree lets a suggestion stop at the
 * deepest node the evidence actually supports instead of reporting a
 * medium-confidence leaf or nothing.
 */
export interface BranchPlacement<C> {
  node: C;
  /** Summed probability of `node` and every candidate beneath it. */
  probability: number;
}

/** Guards a malformed parent chain; the category tree is at most 3 deep. */
const MAX_WALK = 16;

export function placeByBranch<C>(args: {
  distribution: readonly { candidate: C; probability: number }[];
  selected: C;
  selectedProbability: number;
  threshold: number;
  idOf: (candidate: C) => string;
  parentIdOf: (candidate: C) => string | null;
}): BranchPlacement<C> | null {
  const { distribution, selected, idOf, parentIdOf, threshold } = args;
  if (args.selectedProbability >= threshold) return null;

  const byId = new Map(distribution.map((d) => [idOf(d.candidate), d]));
  const mass = new Map<string, number>();
  for (const { candidate, probability } of distribution) {
    let id: string | null = idOf(candidate);
    for (let step = 0; id !== null && step < MAX_WALK; step++) {
      mass.set(id, (mass.get(id) ?? 0) + probability);
      const node = byId.get(id);
      id = node ? parentIdOf(node.candidate) : null;
    }
  }

  let id: string | null = idOf(selected);
  for (let step = 0; id !== null && step < MAX_WALK; step++) {
    const node = byId.get(id);
    if (!node) return null;
    const branch = mass.get(id) ?? 0;
    if (branch >= threshold) {
      return { node: node.candidate, probability: Math.min(branch, 1) };
    }
    id = parentIdOf(node.candidate);
  }
  return null;
}
