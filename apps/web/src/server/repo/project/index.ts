/**
 * Project repository — public API barrel.
 *
 * A Project is a household undertaking tracked from the retired Notion
 * project database — see packages/schemas/src/project.ts for the full domain
 * doc comment (rollups, dependency-edge semantics, free-form `locations`).
 * Import project operations from `~/server/repo/project` (this barrel).
 *
 *   CRUD      → `crud.ts`      (create / update / delete + by-id read; update
 *                                handles the `blockedByIds` full-replacement
 *                                set, delete guards on live tasks/purchases)
 *   LOOKUP    → `lookup.ts`    (filtered/sorted/paginated list, id→name lookup)
 *   ANALYTICS → `analytics.ts` (batched cost/progress OWN rollups + dependency-
 *                                edge reads, shared by crud.ts and lookup.ts)
 *   SUBTREE   → `subtree.ts`   (arbitrary-depth sub-project tree: descendant-id
 *                                computation + recursive subtree rollup
 *                                aggregation on top of analytics.ts's OWN
 *                                rollups; internal to crud.ts/lookup.ts —
 *                                task/actionable.ts's separate ancestor walk
 *                                only needs id/parentProjectId, fetched inline
 *                                there)
 *
 * Sibling relationships: referenced by `task.projectId` and `purchase.projectId`
 * (both nullable); `projectDependency` self-references `project` for the
 * blocked-by/blocking graph; `project.parentProjectId` self-references
 * `project` for the sub-project tree (see `subtree.ts`). `helpers.ts` and
 * `subtree.ts` (row→API mapping, tree aggregation) are internal.
 */

export {
  assertProjectLive,
  createProject,
  deleteProjects,
  getProjectByID,
  updateProject,
} from "./crud";
export { projectList, projectNameOptions } from "./lookup";
