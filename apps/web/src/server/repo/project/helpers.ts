import type { DataQuality } from "@cubby/schemas/data-quality";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import { type ProjectId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProjectDateWindow,
  ProjectOut,
  ProjectRollup,
} from "@cubby/schemas/project";

import type { ProjectParentRow } from "./subtree";

/** Shape of a `project` row as returned by a plain (no relations) select. */
export type ProjectRow = {
  id: ProjectId;
  shortcode: string;
  name: string;
  status: ProjectOut["status"];
  kind: ProjectOut["kind"];
  locations: string[];
  locationsMode: "inherit" | "explicit";
  defaultTrade: ProjectOut["defaultTrade"];
  costEstimate: number | null;
  parentProjectId: ProjectId | null;
  startDate: string | null;
  endDate: string | null;
  icon: string | null;
  notes: string | null;
  googleDriveFolderUrl: string | null;
  notionPageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Resolve project-only inherited settings from the already-loaded tree. */
const resolveInheritedProjectSettings = (
  row: ProjectRow,
  allRows: ReadonlyArray<{
    id: ProjectId;
    shortcode: string;
    parentProjectId: ProjectId | null;
    locations: string[];
    locationsMode: "inherit" | "explicit";
    defaultTrade: ProjectOut["defaultTrade"];
  }>,
) => {
  const byId = new Map(allRows.map((item) => [item.id, item]));
  let current: (typeof allRows)[number] | ProjectRow | undefined = row;
  const seen = new Set<ProjectId>();
  let locations: string[] | null = null;
  let defaultTrade: ProjectOut["defaultTrade"] = null;
  let locationsSource: string | null = null;
  let tradeSource: string | null = null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (locations === null && current.locationsMode === "explicit") {
      locations = current.locations;
      locationsSource = current.shortcode;
    }
    if (defaultTrade === null && current.defaultTrade !== null) {
      defaultTrade = current.defaultTrade;
      tradeSource = current.shortcode;
    }
    current = current.parentProjectId
      ? byId.get(current.parentProjectId)
      : undefined;
  }
  return {
    locations: locations ?? [],
    defaultTrade,
    locationsSource,
    tradeSource,
  };
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
  parentProjectShortcode,
  childProjectIds,
  allRows,
  dataQuality,
}: {
  row: ProjectRow;
  ownRollup: ProjectOwnRollup;
  subtreeRollup: ProjectSubtreeRollup;
  dates: ProjectDateWindow;
  blockedByIds: string[];
  blockingIds: string[];
  parentProjectName: string | null;
  parentProjectShortcode: string | null;
  childProjectIds: string[];
  allRows: Parameters<typeof resolveInheritedProjectSettings>[1];
  dataQuality: DataQuality;
}): ProjectOut => {
  const resolved = resolveInheritedProjectSettings(row, allRows);
  const fallback = resolveInheritedProjectSettings(
    { ...row, locationsMode: "inherit", defaultTrade: null },
    allRows,
  );
  const reference = (shortcode: string | null) =>
    shortcode ? { entityType: "project" as const, entityId: shortcode } : null;
  return {
    id: parseShortcodeFor("project", row.shortcode),
    name: row.name,
    status: row.status,
    kind: row.kind,
    locations: resolved.locations,
    defaultTrade: resolved.defaultTrade,
    fieldResolutions: {
      locations: {
        mode:
          row.locationsMode === "explicit"
            ? row.locations.length === 0
              ? "none"
              : "explicit"
            : "inherit",
        storedValue: row.locations,
        value: resolved.locations,
        fallbackValue: fallback.locations,
        source:
          row.locationsMode === "explicit"
            ? "Project override"
            : resolved.locationsSource
              ? "Parent project"
              : "No site names",
        sourceEntity:
          row.locationsMode === "inherit"
            ? reference(resolved.locationsSource)
            : null,
        matchesFallback:
          row.locationsMode === "explicit" &&
          row.locations.length > 0 &&
          [...row.locations].sort().join("\0") ===
            [...fallback.locations].sort().join("\0"),
        canReset: row.locationsMode === "explicit",
      },
      defaultTrade: {
        mode: row.defaultTrade === null ? "inherit" : "explicit",
        storedValue: row.defaultTrade,
        value: resolved.defaultTrade,
        fallbackValue: fallback.defaultTrade,
        source:
          row.defaultTrade !== null
            ? "Project override"
            : resolved.tradeSource
              ? "Parent project"
              : "No trade default",
        sourceEntity:
          row.defaultTrade === null ? reference(resolved.tradeSource) : null,
        matchesFallback:
          row.defaultTrade !== null &&
          row.defaultTrade === fallback.defaultTrade,
        canReset: row.defaultTrade !== null,
      },
    } satisfies FieldResolutions,
    costEstimate: row.costEstimate,
    parentProjectId: parentProjectShortcode
      ? parseShortcodeFor("project", parentProjectShortcode)
      : null,
    parentProjectName,
    childProjectIds: childProjectIds.map((id) =>
      parseShortcodeFor("project", id),
    ),
    startDate: row.startDate,
    endDate: row.endDate,
    icon: row.icon,
    notes: row.notes,
    googleDriveFolderUrl: row.googleDriveFolderUrl,
    notionPageUrl: row.notionPageUrl,
    blockedByIds: blockedByIds.map((id) => parseShortcodeFor("project", id)),
    blockingIds: blockingIds.map((id) => parseShortcodeFor("project", id)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rollup: { ...ownRollup, subtree: subtreeRollup },
    dates,
    dataQuality,
  };
};

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
    shortcodeById: Map<ProjectId, string>;
    childrenByParent: Map<ProjectId, ProjectId[]>;
    allRows: ProjectParentRow[];
  },
  dependencies: {
    blockedBy: Map<ProjectId, ProjectId[]>;
    blocking: Map<ProjectId, ProjectId[]>;
  },
  dataQuality: DataQuality,
): ProjectOut => {
  const toShortcode = (id: ProjectId) => context.shortcodeById.get(id) ?? "";
  return dbProjectToAPI({
    row,
    ownRollup: context.ownRollups.get(row.id) ?? EMPTY_PROJECT_OWN_ROLLUP,
    subtreeRollup:
      context.subtreeRollups.get(row.id) ?? EMPTY_PROJECT_SUBTREE_ROLLUP,
    dates: context.dateWindows.get(row.id) ?? EMPTY_PROJECT_DATE_WINDOW,
    blockedByIds: (dependencies.blockedBy.get(row.id) ?? []).map(toShortcode),
    blockingIds: (dependencies.blocking.get(row.id) ?? []).map(toShortcode),
    parentProjectName: row.parentProjectId
      ? (context.nameById.get(row.parentProjectId) ?? null)
      : null,
    parentProjectShortcode: row.parentProjectId
      ? (context.shortcodeById.get(row.parentProjectId) ?? null)
      : null,
    childProjectIds: (context.childrenByParent.get(row.id) ?? []).map(
      toShortcode,
    ),
    allRows: context.allRows,
    dataQuality,
  });
};
