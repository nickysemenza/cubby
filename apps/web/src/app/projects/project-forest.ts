/**
 * The parent→children walk under the WBS table (`project-tree.ts`): one
 * orphan-promotion rule, one depth cap, and one cycle guard. Row shapes stay
 * with the caller as the `fold` and `descend` it hands to {@link foldForest}.
 *
 * No React, no DOM, alias-free: this runs under vitest's `unit` project (see
 * vitest.config.ts), same layer as `spend.ts`.
 */

import { MAX_PROJECT_TREE_DEPTH } from "@cubby/schemas/project";

/** The only two fields a forest walk reads off a project row. */
export interface ForestNode {
  id: string;
  parentProjectId: string | null;
}

export interface Forest<T extends ForestNode> {
  /**
   * Nodes to start walking from, in input order. A node is a root when it has
   * no parent OR its parent isn't in the input — **orphan promotion**: a child
   * whose parent was filtered out (a chip, a server-side filter) renders as a
   * root instead of vanishing.
   */
  roots: T[];
  /** Direct children by parent id, input order preserved within each group. */
  childrenByParent: Map<string, T[]>;
  /**
   * Nodes whose ancestor chain loops without ever reaching a root — i.e. a
   * genuine parent cycle, unreachable from {@link roots}. Kept separate rather
   * than folded into `roots` because the two surfaces want opposite things: the
   * WBS table promotes them so the rows still render, the Gantt leaves them out.
   * Callers pass them (or don't) via `foldForest`'s `roots` option, which makes
   * that policy a visible decision instead of an accident.
   */
  cyclicRoots: T[];
}

export function buildForest<T extends ForestNode>(
  items: readonly T[],
): Forest<T> {
  const byId = new Map(items.map((item) => [item.id, item]));

  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parentId = item.parentProjectId;
    if (parentId == null || !byId.has(parentId)) {
      roots.push(item);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings) {
      siblings.push(item);
    } else {
      childrenByParent.set(parentId, [item]);
    }
  }

  /**
   * Walks `item`'s ancestor chain (ignoring the depth cap) to tell a genuine
   * parent cycle apart from a merely deep-but-acyclic chain: `false` iff the
   * chain revisits a node without reaching a root. Bounded by the number of
   * nodes, so it terminates regardless.
   */
  const hasAcyclicPathToRoot = (item: T): boolean => {
    const seen = new Set<string>();
    let current = item;
    for (;;) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      const parentId = current.parentProjectId;
      if (parentId == null) return true;
      // One lookup, not `has` + `get`: a missing parent IS the orphan-root
      // case, so the undefined this guards is the answer rather than an
      // unreachable fallback the type system would otherwise demand.
      const parent = byId.get(parentId);
      if (!parent) return true;
      current = parent;
    }
  };

  const cyclicRoots = items.filter((item) => !hasAcyclicPathToRoot(item));

  return { roots, childrenByParent, cyclicRoots };
}

interface FoldForestOptions<T extends ForestNode> {
  /** Override the starting set. Defaults to `forest.roots`. */
  roots?: readonly T[];
  /** Walk into this node's children? Defaults to always. */
  descend?: (node: T, depth: number) => boolean;
}

/**
 * Depth-capped, cycle-guarded post-order fold over the forest, returning one
 * result per walked root.
 *
 * Three guarantees the callers depend on:
 *
 * - **Every node is folded at most once per call**, enforced at both ends: the
 *   root loop skips a node already produced, and a node re-reached during
 *   recursion returns its memoized fold. Both are load-bearing when `roots`
 *   contains descendants — as the Gantt's extent pass does, passing every node
 *   so nodes inside a cycle still get one. Without the memo, a `roots` array
 *   that happens to list a child before its parent re-folds that whole subtree
 *   when the parent's walk reaches it: quadratic on a deep chain in leaf-first
 *   order, which server-sorted rows can trivially produce. The memo also keeps
 *   the parent's `childResults` complete — skipping an already-emitted child
 *   instead would silently drop it from its parent's fold.
 * - **A cycle-closing edge is dropped, not followed.** A child already on the
 *   current recursion stack is its own ancestor; descending again is the cycle.
 *   Dropping the edge (rather than the node) keeps every reachable node present.
 * - **At `MAX_PROJECT_TREE_DEPTH` the walk stops going deeper**, folding that
 *   node with no children rather than omitting it. So a too-deep acyclic chain
 *   is truncated, never turned into spurious extra roots. The cap and the cycle
 *   guard are independent valves for two different failure modes — a very deep
 *   but acyclic chain, and a parent loop of any length. These walks run in the
 *   browser, where an unguarded cycle is a stack overflow that takes the whole
 *   page down rather than a failed query.
 */
export function foldForest<T extends ForestNode, R>(
  forest: Forest<T>,
  fold: (node: T, childResults: R[], depth: number) => R,
  options?: FoldForestOptions<T>,
): R[] {
  const { childrenByParent } = forest;
  const emitted = new Set<string>();
  const onStack = new Set<string>();
  const memo = new Map<string, { value: R }>();

  function visit(node: T, depth: number): R {
    // `has` then `get` (not a `!= null` test): `R` may legitimately be
    // undefined, and a memoized undefined still means "already folded".
    const memoized = memo.get(node.id);
    if (memoized) return memoized.value;
    emitted.add(node.id);
    // The two truncating exits are deliberately NOT memoized: both fold a
    // partial view of the node (no children), and the same node reached later
    // by a shallower or expanded path deserves its full fold.
    if (depth >= MAX_PROJECT_TREE_DEPTH) return fold(node, [], depth);
    if (options?.descend && !options.descend(node, depth)) {
      return fold(node, [], depth);
    }
    onStack.add(node.id);
    const childResults: R[] = [];
    for (const child of childrenByParent.get(node.id) ?? []) {
      if (onStack.has(child.id)) continue;
      childResults.push(visit(child, depth + 1));
    }
    onStack.delete(node.id);
    const result = fold(node, childResults, depth);
    memo.set(node.id, { value: result });
    return result;
  }

  const results: R[] = [];
  for (const root of options?.roots ?? forest.roots) {
    if (emitted.has(root.id)) continue;
    results.push(visit(root, 0));
  }
  return results;
}
