/**
 * Task repository — public API barrel.
 *
 * A Task is a step inside a Project (nullable `projectId` — future inbox tasks
 * may exist without one). See packages/schemas/src/project.ts for the domain
 * doc comment. Import task operations from `~/server/repo/task` (this barrel).
 *
 *   CRUD   → `crud.ts`   (create / update / delete + by-id read; update
 *                          handles the `blockedByIds` full-replacement set,
 *                          exactly mirroring project/crud.ts's shape)
 *   LOOKUP → `lookup.ts` (filtered/sorted/paginated list)
 *
 * Sibling relationships: `task.projectId` references `project`;
 * `taskDependency` self-references `task` for the blocked-by/blocking graph.
 * No rollups (unlike project) — `helpers.ts` (row→API mapping) is internal.
 */
export {
  createTask,
  deleteTasks,
  getTaskByID,
  updateTask,
} from "./crud";
export { taskList } from "./lookup";
