/**
 * Shared project-scope filtering for the two dashboard endpoints
 * (`dashboard-summary.ts`, `portfolio-analytics.ts`) — both take the same
 * `statusScope`/`kinds`/`locations`/`search` filter shape
 * (`projectDashboardFiltersSchema`) and need the same "which live projects
 * match" condition, so the SQL lives here once instead of twice.
 */
import type { ProjectDashboardFilters } from "@cubby/schemas/project";
import { inArray, ne, type SQL, sql } from "drizzle-orm";
import { project } from "~/server/db/schema";
import { buildSearchConditions } from "~/server/repo/database-helpers";

/**
 * `kinds`/`locations` conditions only (no status, no search) — factored out
 * so `dashboard-summary.ts` can reuse them for the `activeProjectCount`/
 * `completedCount` stats, which need a FIXED status condition (`!= 'done'` /
 * `= 'done'`) regardless of what `statusScope` the caller passed, rather
 * than {@link buildDashboardProjectWhere}'s scoped default.
 */
export function dashboardKindLocationConditions(
  filters: Pick<ProjectDashboardFilters, "kinds" | "locations">,
): Array<SQL | undefined> {
  return [
    filters.kinds && filters.kinds.length > 0
      ? inArray(project.kind, filters.kinds)
      : undefined,
    // `locations` is a free-form text[] column — array-overlap membership
    // (project matches if ANY of its locations is in the filter set), the
    // other direction of the singular `location` filter in
    // project/lookup.ts (`= ANY(...)`).
    filters.locations && filters.locations.length > 0
      ? sql`${project.locations} && ${filters.locations}`
      : undefined,
  ];
}

/**
 * WHERE clause for the dashboard's filtered project set: `statusScope`
 * (defaults to excluding `done` when omitted/empty — Overview's default
 * view), `kinds`/`locations`, and `search` (name ilike), always live
 * (`notDeleted`, via `buildSearchConditions`).
 */
export function buildDashboardProjectWhere(
  filters: ProjectDashboardFilters,
): SQL | undefined {
  const statusCondition =
    filters.statusScope && filters.statusScope.length > 0
      ? inArray(project.status, filters.statusScope)
      : ne(project.status, "done");

  return buildSearchConditions(
    project,
    [{ column: project.name, term: filters.search }],
    [statusCondition, ...dashboardKindLocationConditions(filters)],
  );
}
