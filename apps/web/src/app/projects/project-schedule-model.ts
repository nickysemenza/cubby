import type { ProjectListItemOut } from "@cubby/schemas/project";
import { addDays, format, parseISO } from "date-fns";

import {
  projectScheduleRow,
  type ProjectScheduleRow,
} from "~/lib/project-schedule";

import { buildProjectTree } from "./project-tree";

/** A schedule row plus the viewer's own expand state. */
export type ProjectScheduleEntry = ProjectScheduleRow & { expanded?: boolean };

const PLAN_COLOR = "var(--domain-plan)";

/** The grid's rows: the same segments, drawn in the plan domain colour. */
export function scheduleGridRows(rows: readonly ProjectScheduleEntry[]) {
  return rows.map((row) => ({
    ...row,
    segments: row.segments.map((segment) => ({
      ...segment,
      color: PLAN_COLOR,
    })),
  }));
}

/** The server already selected and paged the filtered forest by root. */
export function buildPortfolioScheduleRows(
  projects: ProjectListItemOut[],
  collapsed: ReadonlySet<string>,
): ProjectScheduleEntry[] {
  const rows: ProjectScheduleEntry[] = [];
  const walk = (
    project: ReturnType<typeof buildProjectTree>[number],
    depth: number,
  ) => {
    const expandable = project.subRows.length > 0;
    const expanded = expandable && !collapsed.has(project.id);
    rows.push({
      ...projectScheduleRow(project, depth, expandable),
      expanded,
    });
    if (expanded) for (const child of project.subRows) walk(child, depth + 1);
  };
  for (const root of buildProjectTree(projects)) walk(root, 0);
  return rows;
}

/**
 * The report's rows (every live descendant and task, in tree order) with
 * collapsed subtrees hidden. Collapse is the viewer's own state, so it is the
 * only thing derived here.
 */
export function visibleScheduleRows(
  rows: readonly ProjectScheduleRow[],
  collapsed: ReadonlySet<string>,
): ProjectScheduleEntry[] {
  const visible: ProjectScheduleEntry[] = [];
  let hiddenBelow: number | null = null;
  for (const row of rows) {
    if (hiddenBelow !== null && row.depth > hiddenBelow) continue;
    hiddenBelow = null;
    const expanded = row.expandable && !collapsed.has(row.id);
    visible.push({ ...row, expanded });
    if (row.expandable && !expanded) hiddenBelow = row.depth;
  }
  return visible;
}

export function projectScheduleWindow(
  rows: readonly ProjectScheduleEntry[],
  today = new Date(),
) {
  const dates = rows.flatMap((row) =>
    row.segments.flatMap((segment) => [
      segment.startDate,
      segment.endDate ?? segment.startDate,
    ]),
  );
  const first = dates.length
    ? dates.reduce((a, b) => (a < b ? a : b))
    : format(today, "yyyy-MM-dd");
  const last = dates.length
    ? dates.reduce((a, b) => (a > b ? a : b))
    : format(today, "yyyy-MM-dd");
  return {
    startDate: format(addDays(parseISO(first), -14), "yyyy-MM-dd"),
    endDate: format(addDays(parseISO(last), 45), "yyyy-MM-dd"),
  };
}
