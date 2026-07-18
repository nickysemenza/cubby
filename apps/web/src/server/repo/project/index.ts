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
 *   ANALYTICS → `analytics.ts` (batched cost/progress rollups + dependency-edge
 *                                reads, shared by crud.ts and lookup.ts)
 *
 * Sibling relationships: referenced by `task.projectId` and `purchase.projectId`
 * (both nullable); `projectDependency` self-references `project` for the
 * blocked-by/blocking graph. `helpers.ts` (row→API mapping) is internal.
 */

export {
  createProject,
  deleteProjects,
  getProjectByID,
  updateProject,
} from "./crud";
export { projectList, projectNameOptions } from "./lookup";
