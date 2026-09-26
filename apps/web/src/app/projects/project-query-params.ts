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
 * shared `MAX_PAGE_SIZE` — one page covers the schedule's whole descendant
 * project subtree. */
const PROJECT_SCOPED_PAGE_SIZE = 500;

/** The task/expense `chartData` endpoints take the bare filters object (no
 * sort/pagination wrapper — they fetch-all). One subtree fetch feeds the
 * schedule, the Task Timeline, the Task Board view, the Budget/spend charts, AND
 * (as of `project-detail-page.tsx`'s embedded Tasks/Expenses section tables)
 * those tables too — the previously-separate scoped `task.list`/`expense.list`
 * queries that bounded what those tables rendered were removed, since they
 * were redundant round-trips over data this fetch already has. The one
 * default those scoped queries used to encode (List view showing open tasks
 * first) is now a visible, user-clearable column filter on the embedded
 * `TaskList` (`OPEN_TASK_FILTERS`), not a separate fetch. */
export function projectSubtreeTasksFilters(projectId: string) {
  return { projectId, includeSubProjects: true };
}

export function projectSubtreeExpensesFilters(projectId: string) {
  return { projectId, includeSubProjects: true };
}

/** The schedule's sub-project rows span arbitrary depth, so it needs the whole
 * live descendant subtree — not the direct-children query the Sub-projects
 * section relies on. Kept separate for exactly that reason. */
export function projectScheduleSubtreeQueryParams(projectId: string) {
  return {
    filters: { parentProjectId: projectId, includeSubProjects: true },
    sort: { orderBy: "name" as const, direction: "asc" as const },
    pagination: { pageIndex: 0, pageSize: PROJECT_SCOPED_PAGE_SIZE },
  };
}
