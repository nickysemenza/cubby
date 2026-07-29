import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  ProjectDateWindow,
  ProjectOut,
  ProjectRollup,
} from "@cubby/schemas/project";

/** Shape of a `project` row as returned by a plain (no relations) select. */
type ProjectRow = {
  id: ProjectOut["id"];
  name: string;
  status: ProjectOut["status"];
  kind: ProjectOut["kind"];
  locations: string[];
  costEstimate: number | null;
  parentProjectId: ProjectId | null;
  startDate: string | null;
  endDate: string | null;
  icon: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** This project's own (non-recursive) rollup — see `ProjectRollup`'s doc comment. */
export type ProjectOwnRollup = Omit<ProjectRollup, "subtree">;
export type ProjectSubtreeRollup = ProjectRollup["subtree"];

/** Own-rollup zeros — the per-project aggregate for a project with no purchases/tasks yet. */
export const EMPTY_PROJECT_OWN_ROLLUP: ProjectOwnRollup = {
  spent: 0,
  actualSpent: 0,
  committedSpent: 0,
  contributions: 0,
  purchaseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
};

/**
 * A project's OWN dated content bounds — min/max over its live tasks and
 * purchases, before any parent/child folding. See analytics.ts's
 * `projectRollups` and subtree.ts's `aggregateSubtreeDates`.
 */
export type ProjectContentDates = {
  contentStart: string | null;
  contentEnd: string | null;
};

/** Content-date zeros — a project with no dated tasks or purchases. */
export const EMPTY_PROJECT_CONTENT_DATES: ProjectContentDates = {
  contentStart: null,
  contentEnd: null,
};

/** A project with no dates from any source. */
export const EMPTY_PROJECT_DATE_WINDOW: ProjectDateWindow = {
  derivedStart: null,
  derivedEnd: null,
  effectiveStart: null,
  effectiveEnd: null,
  startSource: "none",
  endSource: "none",
};

/**
 * Null-tolerant min/max over plain `"YYYY-MM-DD"` dates, where null means
 * "no bound from this source" rather than a value to compare — so
 * `minPlainDate(null, x) === x`, not null. Zero-padded ISO dates order
 * correctly under plain string comparison, the same assumption `gantt-date.ts`
 * and the task board's sort already make.
 */
export const minPlainDate = (
  a: string | null,
  b: string | null,
): string | null => (a == null ? b : b == null ? a : a < b ? a : b);

export const maxPlainDate = (
  a: string | null,
  b: string | null,
): string | null => (a == null ? b : b == null ? a : a > b ? a : b);

/** Subtree-rollup zeros — a project with no live descendants. */
export const EMPTY_PROJECT_SUBTREE_ROLLUP: ProjectSubtreeRollup = {
  spent: 0,
  actualSpent: 0,
  committedSpent: 0,
  contributions: 0,
  purchaseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
  projectCount: 0,
  costEstimate: null,
};

/**
 * Row + everything computed about it → `ProjectOut`. Takes a single options
 * object rather than a positional list: it already carried seven arguments,
 * three of which are same-typed id arrays, and the date window made eight.
 */
export const dbProjectToAPI = ({
  row,
  ownRollup,
  subtreeRollup,
  dates,
  blockedByIds,
  blockingIds,
  parentProjectName,
  childProjectIds,
}: {
  row: ProjectRow;
  ownRollup: ProjectOwnRollup;
  subtreeRollup: ProjectSubtreeRollup;
  dates: ProjectDateWindow;
  blockedByIds: ProjectId[];
  blockingIds: ProjectId[];
  parentProjectName: string | null;
  childProjectIds: ProjectId[];
}): ProjectOut => ({
  id: row.id,
  name: row.name,
  status: row.status,
  kind: row.kind,
  locations: row.locations,
  costEstimate: row.costEstimate,
  parentProjectId: row.parentProjectId,
  parentProjectName,
  childProjectIds,
  startDate: row.startDate,
  endDate: row.endDate,
  icon: row.icon,
  notes: row.notes,
  blockedByIds,
  blockingIds,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  rollup: { ...ownRollup, subtree: subtreeRollup },
  dates,
});
