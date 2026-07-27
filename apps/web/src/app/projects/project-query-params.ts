/**
 * Query params shared between the project-detail route's `loader` and the
 * page component's own queries — identical params ⇒ identical query key ⇒ the
 * loader's prefetch lands in the same cache entry the component reads.
 *
 * These live in their own dependency-free module on purpose. TanStack Start's
 * code-splitting moves a route's `component:` into a lazy chunk but keeps
 * `loader` eager, so anything the loader imports is pinned to the eager
 * route-definition chunk. When these helpers lived in `project-detail-page.tsx`
 * they dragged that whole module graph (nivo + react-spring + d3, the
 * data-table, json-edit-react — 97 chunks / ~358 KiB gzip) onto the critical
 * path of every page load. Keep this file free of React and of any import that
 * isn't a type.
 */

/** Cap well above any real subtree size (hundreds at most) but within the
 * shared `MAX_PAGE_SIZE` — one page covers the Gantt's whole descendant
 * project subtree. */
const PROJECT_SCOPED_PAGE_SIZE = 500;

/** The task/purchase `chartData` endpoints take the bare filters object (no
 * sort/pagination wrapper — they fetch-all). One subtree fetch feeds the
 * Gantt, the Task Timeline, the Task Board view, and the Budget/spend
 * charts — all of which need the whole (incl. done/past) subtree picture.
 * The Tasks/Purchases *list* views intentionally do NOT read from this
 * fetch (see `openTaskFilters`/`plannedPurchaseFilters` in
 * `project-detail-page.tsx`) — a completed project with hundreds of historical
 * rows shouldn't pull them all in just to render its default (open-tasks /
 * recent-purchases) view. */
export function projectSubtreeTasksFilters(projectId: string) {
  return { projectId, includeSubProjects: true };
}

export function projectSubtreePurchasesFilters(projectId: string) {
  return { projectId, includeSubProjects: true };
}

/** The Gantt's sub-project rows span arbitrary depth, so it needs the whole
 * live descendant subtree — not the direct-children query the Sub-projects
 * section relies on. Kept separate for exactly that reason. */
export function projectGanttSubtreeQueryParams(projectId: string) {
  return {
    filters: { parentProjectId: projectId, includeSubProjects: true },
    sort: { orderBy: "name" as const, direction: "asc" as const },
    pagination: { pageIndex: 0, pageSize: PROJECT_SCOPED_PAGE_SIZE },
  };
}
