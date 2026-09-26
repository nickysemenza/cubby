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
 *                                set, delete guards on live tasks/expenses)
 *   LOOKUP    → `lookup.ts`    (filtered/sorted/paginated list, id→name lookup)
 *   TREE      → `tree.ts`      (the same filters as `lookup.ts`, paginated by
 *                                root of the filtered forest, for the Projects
 *                                Data tab's WBS renderer)
 *   ANALYTICS → `analytics.ts` (batched cost/progress OWN rollups + dependency-
 *                                edge reads, shared by crud.ts and lookup.ts)
 *   SUBTREE   → `subtree.ts`   (arbitrary-depth sub-project tree: descendant-id
 *                                computation + recursive subtree rollup
 *                                aggregation on top of analytics.ts's OWN
 *                                rollups; internal to crud.ts/lookup.ts —
 *                                task/actionable.ts's separate ancestor walk
 *                                only needs id/parentProjectId, fetched inline
 *                                there)
 *   DASHBOARD → `dashboard-summary.ts` / `portfolio-analytics.ts` (the
 *                                Overview/Charts reads behind
 *                                `project.dashboardSummary` /
 *                                `project.portfolioAnalytics` — bounded
 *                                summaries + on-demand chart aggregates,
 *                                replacing the old fetch-all
 *                                `project.dashboard`), backed by
 *                                `attention.ts` (the server-side Needs
 *                                Attention detector) and `dashboard-shared.ts`
 *                                (their common filter-scope SQL)
 *
 * Sibling relationships: referenced by `task.projectId` and `expense.projectId`
 * (both nullable); `projectDependency` self-references `project` for the
 * blocked-by/blocking graph; `project.parentProjectId` self-references
 * `project` for the sub-project tree (see `subtree.ts`). `helpers.ts` and
 * `subtree.ts` (row→API mapping, tree aggregation) are internal.
 */

export { computeAttentionItems } from "./attention";
export {
  createProject,
  deleteProjects,
  getProjectByID,
  updateProject,
} from "./crud";
export { projectDashboardSummary } from "./dashboard-summary";
export { getProjectDependencyGraph } from "./dependency-graph";
export { projectList, projectNameOptions } from "./lookup";
export { projectPortfolioAnalytics } from "./portfolio-analytics";
export { projectToolGallery } from "./tool-gallery";
export { projectToolMatrix } from "./tool-matrix";
export {
  listProductProjectUses,
  repointProjectUses,
  setProductProjectUses,
  setProjectToolUsage,
  suggestProjectTools,
} from "./tools";
export { projectTreePage } from "./tree";
