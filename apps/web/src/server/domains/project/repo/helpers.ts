import type { DataQuality } from "@cubby/schemas/data-quality";
import { dateRangeFromDates } from "@cubby/schemas/date-range";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import {
  type LedgerPartyId,
  type ProjectId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
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
  assigneeId: LedgerPartyId | null;
  assigneeMode: "inherit" | "explicit";
  locations: string[];
  locationsMode: "inherit" | "explicit";
  defaultTrade: ProjectOut["defaultTrade"];
  costEstimate: number | null;
  parentProjectId: ProjectId | null;
  startDate: string | null;
  endDate: string | null;
  emoji?: string | null;
  notes: string | null;
  googleDriveFolderUrl: string | null;
  notionPageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A project's inherited settings, read from the projects its declared
 * chains (`resolution.inherit`) chose when the tree loaded: `effective`
 * for the value, `withoutOwn` for what it would inherit without its own.
 */
const resolveInheritedProjectSettings = (
  row: Pick<ProjectRow, "id">,
  byId: ReadonlyMap<ProjectId, ProjectParentRow>,
  which: "effective" | "withoutOwn",
) => {
  const sources = byId.get(row.id)?.sources;
  const from = (field: keyof ProjectParentRow["sources"]) => {
    const id = sources?.[field][which] ?? null;
    return id === null ? undefined : byId.get(id);
  };
  const assignee = from("assigneeId") ?? null;
  const locations = from("locations");
  const trade = from("defaultTrade");
  return {
    assignee,
    locations: locations?.locations ?? [],
    defaultTrade: trade?.defaultTrade ?? null,
    locationsSource: locations?.shortcode ?? null,
    tradeSource: trade?.shortcode ?? null,
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
  credits: 0,
  expenseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
};

/**
 * A project's OWN dated content bounds — min/max over its live tasks and
 * expenses, before any parent/child folding. See analytics.ts's
 * `projectRollupsAndContentDates` and subtree.ts's `aggregateSubtreeDates`.
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
  credits: 0,
  expenseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
  projectCount: 0,
  costEstimate: null,
};

export const projectSettingsFields = (
  row: Pick<
    ProjectRow,
    | "id"
    | "assigneeId"
    | "assigneeMode"
    | "locations"
    | "locationsMode"
    | "defaultTrade"
  >,
  rowsById: ReadonlyMap<ProjectId, ProjectParentRow>,
  rowsByShortcode: ReadonlyMap<string, ProjectParentRow>,
) => {
  const resolved = resolveInheritedProjectSettings(row, rowsById, "effective");
  const fallback = resolveInheritedProjectSettings(row, rowsById, "withoutOwn");
  const reference = (shortcode: string | null) =>
    shortcode
      ? {
          entityKind: "project" as const,
          entityId: shortcode,
          name: rowsByShortcode.get(shortcode)?.name ?? null,
        }
      : null;
  return {
    assigneeId: resolved.assignee?.assigneeShortcode
      ? parseShortcodeFor("ledgerParty", resolved.assignee.assigneeShortcode)
      : null,
    assigneeName: resolved.assignee?.assigneeName ?? null,
    locations: resolved.locations,
    defaultTrade: resolved.defaultTrade,
    fieldResolutions: {
      assigneeId: {
        mode:
          row.assigneeMode === "explicit"
            ? row.assigneeId === null
              ? "none"
              : "explicit"
            : "inherit",
        storedValue:
          row.assigneeMode === "explicit"
            ? (rowsById.get(row.id)?.assigneeShortcode ?? null)
            : null,
        value: resolved.assignee?.assigneeShortcode ?? null,
        fallbackValue: fallback.assignee?.assigneeShortcode ?? null,
        source:
          row.assigneeMode === "explicit"
            ? "Project override"
            : resolved.assignee
              ? "Parent project"
              : "Unassigned",
        sourceEntity:
          row.assigneeMode === "inherit"
            ? reference(resolved.assignee?.shortcode ?? null)
            : null,
        matchesFallback:
          row.assigneeMode === "explicit" &&
          row.assigneeId !== null &&
          row.assigneeId === fallback.assignee?.assigneeId,
        canReset: row.assigneeMode === "explicit",
      },
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
  };
};

const dbProjectToAPI = <Q extends DataQuality | undefined>({
  row,
  ownRollup,
  subtreeRollup,
  dates,
  blockedByIds,
  blockingIds,
  parentProjectName,
  parentProjectShortcode,
  childProjectIds,
  rowsById,
  rowsByShortcode,
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
  rowsById: ReadonlyMap<ProjectId, ProjectParentRow>;
  rowsByShortcode: ReadonlyMap<string, ProjectParentRow>;
  dataQuality: Q;
}): Omit<ProjectOut, "dataQuality"> & { dataQuality: Q } => {
  return {
    id: parseShortcodeFor("project", row.shortcode),
    name: row.name,
    status: row.status,
    kind: row.kind,
    ...projectSettingsFields(row, rowsById, rowsByShortcode),
    costEstimate: row.costEstimate,
    parentProjectId: parentProjectShortcode
      ? parseShortcodeFor("project", parentProjectShortcode)
      : null,
    parentProjectName,
    childProjectIds: childProjectIds.map((id) =>
      parseShortcodeFor("project", id),
    ),
    dates: dateRangeFromDates(row.startDate, row.endDate),
    emoji: row.emoji ?? null,
    notes: row.notes,
    googleDriveFolderUrl: row.googleDriveFolderUrl,
    notionPageUrl: row.notionPageUrl,
    blockedByIds: blockedByIds.map((id) => parseShortcodeFor("project", id)),
    blockingIds: blockingIds.map((id) => parseShortcodeFor("project", id)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rollup: { ...ownRollup, subtree: subtreeRollup },
    spent: ownRollup.spent,
    taskProgress: `${ownRollup.doneTaskCount}/${ownRollup.taskCount}`,
    dateWindow: dates,
    dataQuality,
  };
};

/**
 * Apply the repository's canonical empty fallbacks and parent/child/dependency
 * lookups to a project row. Every read path gets the same hydrated shape.
 */
export const hydrateProjectRow = <Q extends DataQuality | undefined>(
  row: ProjectRow,
  context: {
    ownRollups: Map<ProjectId, ProjectOwnRollup>;
    subtreeRollups: Map<ProjectId, ProjectSubtreeRollup>;
    dateWindows: Map<ProjectId, ProjectDateWindow>;
    nameById: Map<ProjectId, string>;
    shortcodeById: Map<ProjectId, string>;
    childrenByParent: Map<ProjectId, ProjectId[]>;
    rowsById: ReadonlyMap<ProjectId, ProjectParentRow>;
    rowsByShortcode: ReadonlyMap<string, ProjectParentRow>;
  },
  dependencies: {
    blockedBy: Map<ProjectId, ProjectId[]>;
    blocking: Map<ProjectId, ProjectId[]>;
  },
  dataQuality: Q,
): Omit<ProjectOut, "dataQuality"> & { dataQuality: Q } => {
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
    rowsById: context.rowsById,
    rowsByShortcode: context.rowsByShortcode,
    dataQuality,
  });
};
