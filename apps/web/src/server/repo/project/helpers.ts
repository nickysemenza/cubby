import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  ProjectDateWindow,
  ProjectOut,
  ProjectRollup,
} from "@cubby/schemas/project";

/** Shape of a `project` row as returned by a plain (no relations) select. */
export type ProjectRow = {
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

/** Own-rollup zeros — the per-project aggregate for a project with no expenses/tasks yet. */
export const EMPTY_PROJECT_OWN_ROLLUP: ProjectOwnRollup = {
  spent: 0,
  actualSpent: 0,
  committedSpent: 0,
  contributions: 0,
  expenseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
};

/**
 * A project's OWN dated content bounds — min/max over its live tasks and
 * expenses, before any parent/child folding. See analytics.ts's
 * `projectRollups` and subtree.ts's `aggregateSubtreeDates`.
 */
export type ProjectContentDates = {
  contentStart: string | null;
  contentEnd: string | null;
};

/** Content-date zeros — a project with no dated tasks or expenses. */
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
  expenseCount: 0,
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
const dbProjectToAPI = ({
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

/**
 * Apply the repository's canonical empty fallbacks and parent/child/dependency
 * lookups to a project row. Every read path gets the same hydrated shape.
 */
export const hydrateProjectRow = (
  row: ProjectRow,
  context: {
    ownRollups: Map<ProjectId, ProjectOwnRollup>;
    subtreeRollups: Map<ProjectId, ProjectSubtreeRollup>;
    dateWindows: Map<ProjectId, ProjectDateWindow>;
    nameById: Map<ProjectId, string>;
    childrenByParent: Map<ProjectId, ProjectId[]>;
  },
  dependencies: {
    blockedBy: Map<ProjectId, ProjectId[]>;
    blocking: Map<ProjectId, ProjectId[]>;
  },
): ProjectOut =>
  dbProjectToAPI({
    row,
    ownRollup: context.ownRollups.get(row.id) ?? EMPTY_PROJECT_OWN_ROLLUP,
    subtreeRollup:
      context.subtreeRollups.get(row.id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP,
    dates: context.dateWindows.get(row.id) ?? EMPTY_PROJECT_DATE_WINDOW,
    blockedByIds: dependencies.blockedBy.get(row.id) ?? [],
    blockingIds: dependencies.blocking.get(row.id) ?? [],
    parentProjectName: row.parentProjectId
      ? (context.nameById.get(row.parentProjectId) ?? null)
      : null,
    childProjectIds: context.childrenByParent.get(row.id) ?? [],
  });
