/**
 * Pure WBS tree builder for the projects table — turns a flat (possibly
 * chip-filtered) `ProjectOut[]` into a nested `ProjectTreeRow[]` that
 * TanStack Table can render as a tree (one root array, `subRows` per node).
 * No React, no DOM: kept alias-free and React-free so it runs under the
 * `*.unit.test.ts` vitest project (see vitest.config.ts), same layer as
 * `spend.ts` and `charts/gantt/gantt-model.ts`.
 */

import type { ProjectOut } from "@cubby/schemas/project";

export type ProjectTreeRow = ProjectOut & { subRows: ProjectTreeRow[] };

/** Sentinel parent key for root-level projects (never a real project id). */
const ROOT_KEY = "__root__";

/**
 * Defensive depth cap on the tree walk, mirroring the server's
 * `MAX_PROJECT_TREE_DEPTH` (repo/project/subtree.ts) and `gantt-model.ts`'s
 * `MAX_TREE_DEPTH`. The create/update cycle guard means a well-formed tree
 * never gets close — but this walk runs in the browser, where an unguarded
 * cycle is a stack overflow that takes the whole page down rather than a
 * failed query.
 */
const MAX_TREE_DEPTH = 100;

/**
 * Builds a nested WBS tree from a flat, possibly-filtered project list.
 *
 * - A project's effective parent is its own `parentProjectId`, UNLESS that
 *   parent isn't present in `projects` (e.g. filtered out by a dashboard
 *   chip) — that child is then promoted to a root instead of vanishing
 *   (orphan promotion, same rationale as `gantt-model.ts`'s
 *   `buildPortfolioRows`, gantt-model.ts:318-326).
 * - Sibling order within a group follows input order (the untied fallback —
 *   TanStack re-sorts per level on top of this).
 * - A corrupt cyclic parent chain (e.g. `a.parentProjectId === b.id` and
 *   `b.parentProjectId === a.id`) can't be represented as a tree — the
 *   on-stack guard cuts the recursion the moment it would revisit an
 *   ancestor, so the cycle-closing edge is simply dropped rather than the
 *   node being duplicated. A node whose ancestor chain is genuinely cyclic
 *   (never reaches a true root) is promoted to a root of its own instead, so
 *   it still renders rather than silently vanishing — that promotion is
 *   deliberately narrower than the depth cap below: a node merely *past* the
 *   depth cap has a perfectly acyclic path to a root, so it's dropped (not
 *   promoted), matching `gantt-model.ts`'s "stop walking deeper" behaviour.
 * - The depth cap and the cycle guard are independent safety valves for two
 *   different failure modes: a very deep-but-acyclic chain (cap) vs. a
 *   parent loop of any length (cycle guard).
 */
export function buildProjectTree(projects: ProjectOut[]): ProjectTreeRow[] {
  const idSet = new Set(projects.map((p) => p.id));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const parentKey = (p: ProjectOut): string =>
    p.parentProjectId != null && idSet.has(p.parentProjectId)
      ? p.parentProjectId
      : ROOT_KEY;

  const childrenByParent = new Map<string, ProjectOut[]>();
  for (const p of projects) {
    const key = parentKey(p);
    const siblings = childrenByParent.get(key);
    if (siblings) {
      siblings.push(p);
    } else {
      childrenByParent.set(key, [p]);
    }
  }

  /**
   * Walks `project`'s ancestor chain (via `parentProjectId`, ignoring
   * `MAX_TREE_DEPTH`) to tell a genuine parent-cycle apart from a merely
   * deep-but-acyclic chain: `false` iff the chain loops back on a project
   * already seen without ever reaching a root (null parent, or a parent
   * outside `projects`). Bounded by `idSet.size`, so this can't loop forever
   * even though it doesn't consult `MAX_TREE_DEPTH`.
   */
  function hasAcyclicPathToRoot(project: ProjectOut): boolean {
    const seen = new Set<string>();
    let current: ProjectOut | undefined = project;
    while (current) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      const parentId = current.parentProjectId;
      if (parentId == null || !idSet.has(parentId)) return true;
      current = byId.get(parentId);
    }
    return true;
  }

  // Ever-visited, across the whole build — used below to find cyclic
  // orphans that the root walk never reached.
  const visited = new Set<string>();
  // On-stack for the current recursion path — a node already on the stack
  // is an ancestor of itself, so descending into it again would be the
  // cycle. Mirrors `computeSubtreeExtents`'s guard in gantt-model.ts.
  const onStack = new Set<string>();

  function walk(project: ProjectOut, depth: number): ProjectTreeRow {
    visited.add(project.id);
    if (depth >= MAX_TREE_DEPTH) {
      return { ...project, subRows: [] };
    }
    onStack.add(project.id);
    const kids = childrenByParent.get(project.id) ?? [];
    const subRows: ProjectTreeRow[] = [];
    for (const kid of kids) {
      // Cycle-closing edge — dropping it (rather than descending again) is
      // what keeps every node appearing exactly once.
      if (onStack.has(kid.id)) continue;
      subRows.push(walk(kid, depth + 1));
    }
    onStack.delete(project.id);
    return { ...project, subRows };
  }

  const rows: ProjectTreeRow[] = [];
  const roots = childrenByParent.get(ROOT_KEY) ?? [];
  for (const root of roots) rows.push(walk(root, 0));

  // Cycle fallback: a node never reached above AND whose ancestor chain is
  // genuinely cyclic is promoted to a root of its own. A node merely past
  // the depth cap (acyclic path to root) is deliberately left dropped.
  for (const p of projects) {
    if (!visited.has(p.id) && !hasAcyclicPathToRoot(p)) rows.push(walk(p, 0));
  }

  return rows;
}
