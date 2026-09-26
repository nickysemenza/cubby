/**
 * WBS nesting for the projects table — turns the flat `ProjectOut[]` the
 * server returned into a nested `ProjectTreeRow[]` that TanStack Table renders
 * as a tree (one root array, `subRows` per node).
 *
 * Presentation only. Membership, ordering, and pagination are the server's:
 * `project.tree` (repo/project/tree.ts) pages by ROOT of the *filtered* forest
 * and returns each page root plus its matching descendants, so this walk never
 * decides which projects the user sees. It preserves input order within each
 * sibling group, which is what makes the server's ORDER BY hold at every level.
 *
 * The walk itself — orphan promotion, depth cap, cycle guard — lives in
 * `project-forest.ts`, shared with `project-schedule-model.ts`.
 *
 * No React, no DOM: kept alias-free and React-free so it runs under the
 * `*.unit.test.ts` vitest project (see vitest.config.ts).
 */

import type { ProjectListItemOut } from "@cubby/schemas/project";

import { buildForest, foldForest } from "./project-forest";

export type ProjectTreeRow = ProjectListItemOut & { subRows: ProjectTreeRow[] };

/**
 * Builds a nested WBS tree from a flat, possibly-filtered project list.
 *
 * Cyclic nodes are walked too (`cyclicRoots`), so a corrupt parent loop still
 * renders as rows rather than silently vanishing — the opposite of the Gantt's
 * choice, and the reason `buildForest` keeps the two sets apart. A node merely
 * *past* the depth cap has a perfectly acyclic path to a root, so it is
 * truncated rather than promoted.
 */
export function buildProjectTree(
  projects: ProjectListItemOut[],
): ProjectTreeRow[] {
  const forest = buildForest(projects);
  return foldForest<ProjectListItemOut, ProjectTreeRow>(
    forest,
    (project, subRows) => ({ ...project, subRows }),
    { roots: [...forest.roots, ...forest.cyclicRoots] },
  );
}
