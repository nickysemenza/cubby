/**
 * Shared project-scope filtering for the two dashboard endpoints
 * (`dashboard-summary.ts`, `portfolio-analytics.ts`) — both take the same
 * `statusScope`/`kinds`/`locations`/`search`/`dateFrom`/`dateTo` filter shape
 * (`projectDashboardFiltersSchema`) and need the same "which projects match"
 * condition, so the SQL lives here once instead of twice.
 *
 * Two honesty rules the UI depends on:
 *   - an empty/omitted `statusScope` adds NO status condition (all four
 *     statuses). It used to silently fall back to `!= 'done'`, which nothing
 *     in the chip bar said — callers that want the live-only default now pass
 *     `LIVE_PROJECT_STATUSES` explicitly (see the MCP `get_house_status`
 *     tool and the Overview default);
 *   - a date window filters the PROJECT set too (interval overlap), not just
 *     the purchase/task aggregates hanging off it.
 */
import type { ProjectDashboardFilters } from "@cubby/schemas/project";
import {
  and,
  arrayOverlaps,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { project } from "~/server/db/schema";
import { buildSearchConditions } from "~/server/repo/database-helpers";

/**
 * `kinds`/`locations` conditions only (no status, no search, no date) —
 * factored out so `dashboard-summary.ts` can reuse them for the
 * `activeProjectCount`/`completedCount` portfolio stats, which need a FIXED
 * status condition (live / `= 'done'`) regardless of what `statusScope` the
 * caller passed, and deliberately ignore the date window: `completedCount`
 * feeds a "N completed projects — view history →" link to an UNSCOPED view,
 * so date-scoping the count would make the number disagree with the page it
 * links to.
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
    //
    // arrayOverlaps, not a hand-rolled sql`${col} && ${arr}`: drizzle
    // interpolates a JS array into raw SQL as a ROW CONSTRUCTOR (`&& ($1,
    // $2)`), which isn't a text[] — the hand-rolled version failed for every
    // location count, one included. Same trap fixed in recipe/crud.ts's tag
    // filter; semantics are unchanged (ANY-of / array overlap).
    filters.locations && filters.locations.length > 0
      ? arrayOverlaps(project.locations, filters.locations)
      : undefined,
  ];
}

/**
 * Status condition for the dashboard scope. Empty/omitted `statusScope` is
 * **no condition at all** (`undefined`) — every status, including `done`.
 * There is no implicit "hide completed" default: an invisible filter the chip
 * bar can't describe is the exact defect this replaced.
 */
function dashboardStatusCondition(
  filters: Pick<ProjectDashboardFilters, "statusScope">,
): SQL | undefined {
  return filters.statusScope && filters.statusScope.length > 0
    ? inArray(project.status, filters.statusScope)
    : undefined;
}

/**
 * Date-window condition for the dashboard scope: a project matches when its
 * `[startDate, endDate]` interval OVERLAPS `[dateFrom, dateTo]`, with a null
 * side read as open-ended (a project with a start and no end is still
 * running). One-sided windows work by construction — the missing bound just
 * drops its half of the comparison. `undefined` when neither bound is set.
 *
 *   (start IS NULL OR start <= dateTo)
 *   AND (end IS NULL OR end >= dateFrom)
 *   AND (start IS NOT NULL OR end IS NOT NULL)
 *
 * The third conjunct is LOAD-BEARING: a project with both dates null passes
 * the first two vacuously and would match every window ever chosen. Undated
 * projects are dropped instead, and the count of exactly those rows is
 * surfaced as `hiddenByDate.projects` (see `buildUndatedProjectWhere`) so the
 * UI can say so out loud.
 *
 * `project.startDate` is indexed (`Project_startDate_idx`); the OR-with-NULL
 * shape means Postgres may not use it, which is fine at this row count.
 */
function dashboardProjectDateCondition(
  filters: Pick<ProjectDashboardFilters, "dateFrom" | "dateTo">,
): SQL | undefined {
  const { dateFrom, dateTo } = filters;
  if (!dateFrom && !dateTo) return undefined;

  return and(
    dateTo
      ? or(isNull(project.startDate), lte(project.startDate, dateTo))
      : undefined,
    dateFrom
      ? or(isNull(project.endDate), gte(project.endDate, dateFrom))
      : undefined,
    or(isNotNull(project.startDate), isNotNull(project.endDate)),
  );
}

/**
 * The full non-search scope: status + kind/location + date window. What both
 * dashboard endpoints filter their project set by.
 */
function dashboardScopeConditions(
  filters: ProjectDashboardFilters,
): Array<SQL | undefined> {
  return [
    dashboardStatusCondition(filters),
    ...dashboardKindLocationConditions(filters),
    dashboardProjectDateCondition(filters),
  ];
}

/**
 * WHERE clause for the dashboard's filtered project set: `statusScope`,
 * `kinds`/`locations`, the `dateFrom`/`dateTo` window, and `search` (name
 * ilike), always live (`notDeleted`, via `buildSearchConditions`).
 */
export function buildDashboardProjectWhere(
  filters: ProjectDashboardFilters,
): SQL | undefined {
  return buildSearchConditions(
    project,
    [{ column: project.name, term: filters.search }],
    dashboardScopeConditions(filters),
  );
}

/**
 * The same scope MINUS the date window, restricted to projects with no dates
 * at all — i.e. exactly the rows {@link buildDashboardProjectWhere} drops
 * *purely* for lacking a date, and nothing dropped on status/kind/location/
 * search grounds. Feeds `hiddenByDate.projects`. Only meaningful while a
 * window is set; the caller skips the query otherwise.
 */
export function buildUndatedProjectWhere(
  filters: ProjectDashboardFilters,
): SQL | undefined {
  return buildSearchConditions(
    project,
    [{ column: project.name, term: filters.search }],
    [
      dashboardStatusCondition(filters),
      ...dashboardKindLocationConditions(filters),
      isNull(project.startDate),
      isNull(project.endDate),
    ],
  );
}
