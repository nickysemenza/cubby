/**
 * Row model for the Gantt chart — pure transforms from `ProjectOut`/`TaskOut`
 * arrays into a flat list of rows a renderer can map 1:1 onto lines. No React,
 * no DOM: this is the same layer as `gantt-date.ts`, consumed by the (future)
 * `.tsx` renderer.
 *
 * Two builders, matching the two surfaces:
 *   - `buildPortfolioRows` — the top-level projects page (Surface A): a WBS
 *     tree of every project, arbitrary depth, expand/collapse per node.
 *   - `buildProjectRows` — a single project's detail page (Surface B): that
 *     project's sub-projects and tasks (the project itself isn't a row —
 *     its own page already frames it).
 */

import {
  type ProjectOut,
  type ProjectStatus,
  projectKindValues,
  type TaskOut,
  type TaskStatus,
  type Trade,
} from "@cubby/schemas/project";
import { groupBy, keyBy } from "es-toolkit";
import { toDayIndex } from "./gantt-date";

export interface GanttProjectRow {
  kind: "project";
  id: string;
  name: string;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  status: ProjectStatus;
  startDay: number | null;
  endDay: number | null;
  /** Has a `startDate` but no `endDate`. */
  openEnded: boolean;
  /**
   * The outer [min, max] day range spanned by this node + all its live
   * descendants, when that range extends beyond the node's own bar. `null`
   * when the node's own bar already covers everything below it (or there's
   * nothing dated below it at all).
   */
  envelope: { startDay: number; endDay: number } | null;
  /** `doneTaskCount / taskCount`, 0 when there are no tasks. */
  progress: number;
  blockedByIds: string[];
  blockingIds: string[];
  /** Live direct child count (0 for a leaf). */
  childCount: number;
}

/** Not exported by name: consumers narrow the `GanttRow` union on `kind`
 * instead. Export it the day something genuinely needs to name it. */
interface GanttTaskRow {
  kind: "task";
  id: string;
  name: string;
  depth: number;
  status: TaskStatus;
  /** A task with `dueDate` but no `dueEndDate` is a 1-day task: startDay === endDay. */
  startDay: number;
  endDay: number;
  trade: Trade;
  blockedByIds: string[];
  blockingIds: string[];
}

/** A lane header for the `groupBy: "kind"` portfolio mode — always shown
 * expanded (round 1). Narrowed off `GanttRow`, not exported by name. */
interface GanttGroupRow {
  kind: "group";
  id: string;
  label: string;
  count: number;
}

export type GanttRow = GanttProjectRow | GanttTaskRow | GanttGroupRow;

export interface DayRange {
  startDay: number;
  endDay: number;
}

/** Sentinel parent key for root-level projects (never a real project id). */
const ROOT_KEY = "__root__";
/**
 * Defensive depth cap on every tree walk here, mirroring the server's
 * `MAX_PROJECT_TREE_DEPTH` (repo/project/subtree.ts). The create/update cycle
 * guard means a well-formed tree never gets close — but these walks run in the
 * browser, where an unguarded cycle is a stack overflow that takes the whole
 * page down rather than a failed query.
 */
const MAX_TREE_DEPTH = 100;
/** Sentinel kind key for projects with a null `kind`, in `groupBy: "kind"` mode. */
const OTHER_KIND_KEY = "other";

function ownStartDay(project: ProjectOut): number | null {
  return project.startDate ? toDayIndex(project.startDate) : null;
}

function ownEndDay(project: ProjectOut): number | null {
  return project.endDate ? toDayIndex(project.endDate) : null;
}

interface Extent {
  min: number | null;
  max: number | null;
}

const EMPTY_EXTENT: Extent = { min: null, max: null };

function considerInto(extent: Extent, value: number | null): Extent {
  if (value == null) return extent;
  return {
    min: extent.min == null || value < extent.min ? value : extent.min,
    max: extent.max == null || value > extent.max ? value : extent.max,
  };
}

/**
 * Post-order DFS over `nodes` (using `childrenByParent`), computing each
 * node's own-dates memoized min/max over itself + every descendant. One pass
 * over the whole node set, O(n).
 */
function computeSubtreeExtents(
  nodes: readonly ProjectOut[],
  childrenByParent: Record<string, ProjectOut[]>,
): Map<string, Extent> {
  const cache = new Map<string, Extent>();
  // Cycle guard: `cache` is only written *after* the recursion, so a cyclic
  // parent chain would otherwise recurse forever. A node already on the stack
  // contributes nothing.
  const onStack = new Set<string>();

  function visit(node: ProjectOut, depth: number): Extent {
    const cached = cache.get(node.id);
    if (cached) return cached;
    if (onStack.has(node.id) || depth >= MAX_TREE_DEPTH) return EMPTY_EXTENT;
    onStack.add(node.id);
    let extent = considerInto(
      considerInto(EMPTY_EXTENT, ownStartDay(node)),
      ownEndDay(node),
    );
    for (const child of childrenByParent[node.id] ?? []) {
      const childExtent = visit(child, depth + 1);
      extent = considerInto(
        considerInto(extent, childExtent.min),
        childExtent.max,
      );
    }
    onStack.delete(node.id);
    cache.set(node.id, extent);
    return extent;
  }

  for (const node of nodes) visit(node, 0);
  return cache;
}

/**
 * The envelope is emitted only when it extends beyond the node's own bar —
 * an undated node emits its descendants' extent unconditionally (there's no
 * "own bar" to compare against).
 */
function computeEnvelope(
  ownStart: number | null,
  ownEnd: number | null,
  extent: Extent,
): DayRange | null {
  if (extent.min == null || extent.max == null) return null;
  if (ownStart == null && ownEnd == null) {
    return { startDay: extent.min, endDay: extent.max };
  }
  const effectiveStart = ownStart ?? ownEnd ?? extent.min;
  const effectiveEnd = ownEnd ?? ownStart ?? extent.max;
  if (extent.min < effectiveStart || extent.max > effectiveEnd) {
    return { startDay: extent.min, endDay: extent.max };
  }
  return null;
}

function computeProgress(project: ProjectOut, childCount: number): number {
  const rollup = childCount > 0 ? project.rollup.subtree : project.rollup;
  return rollup.taskCount > 0 ? rollup.doneTaskCount / rollup.taskCount : 0;
}

function buildProjectRow(
  project: ProjectOut,
  depth: number,
  expandable: boolean,
  expanded: boolean,
  childCount: number,
  extent: Extent,
): GanttProjectRow {
  const startDay = ownStartDay(project);
  const endDay = ownEndDay(project);
  return {
    kind: "project",
    id: project.id,
    name: project.name,
    depth,
    expandable,
    expanded,
    status: project.status,
    startDay,
    endDay,
    openEnded: project.startDate != null && project.endDate == null,
    envelope: computeEnvelope(startDay, endDay, extent),
    progress: computeProgress(project, childCount),
    blockedByIds: project.blockedByIds,
    blockingIds: project.blockingIds,
    childCount,
  };
}

function buildTaskRow(task: TaskOut, depth: number): GanttTaskRow {
  // Callers only invoke this for tasks with a non-null dueDate (undated
  // tasks are surfaced via `unscheduled` instead, never as a row).
  if (task.dueDate == null) {
    throw new Error(`buildTaskRow called for an undated task: ${task.id}`);
  }
  const startDay = toDayIndex(task.dueDate);
  const endDay = task.dueEndDate ? toDayIndex(task.dueEndDate) : startDay;
  return {
    kind: "task",
    id: task.id,
    name: task.name,
    depth,
    status: task.status,
    startDay,
    endDay,
    trade: task.trade,
    blockedByIds: task.blockedByIds,
    blockingIds: task.blockingIds,
  };
}

function kindLabel(kind: string): string {
  if (kind === OTHER_KIND_KEY) return "Other";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function globalExtent(projects: readonly ProjectOut[]): DayRange | null {
  let extent = EMPTY_EXTENT;
  for (const p of projects) {
    extent = considerInto(considerInto(extent, ownStartDay(p)), ownEndDay(p));
  }
  return extent.min != null && extent.max != null
    ? { startDay: extent.min, endDay: extent.max }
    : null;
}

// ---------------------------------------------------------------------------
// Surface A — portfolio (all projects)
// ---------------------------------------------------------------------------

export interface PortfolioRowsResult {
  rows: GanttRow[];
  /** Root-level projects with no own dates and nothing dated beneath them. */
  unscheduled: ProjectOut[];
  extent: DayRange | null;
  /** Same as `extent`, restricted to projects not in a terminal (`done`) status. */
  activeExtent: DayRange | null;
}

export function buildPortfolioRows(
  projects: ProjectOut[],
  expanded: ReadonlySet<string>,
  options?: { groupBy?: "none" | "kind" },
): PortfolioRowsResult {
  const idSet = new Set(projects.map((p) => p.id));
  // Orphan promotion: a project whose parent was filtered out of `projects`
  // renders as a root instead of vanishing.
  const parentKey = (p: ProjectOut): string =>
    p.parentProjectId != null && idSet.has(p.parentProjectId)
      ? p.parentProjectId
      : ROOT_KEY;
  const childrenByParent = groupBy(projects, parentKey);
  const roots = childrenByParent[ROOT_KEY] ?? [];
  const extents = computeSubtreeExtents(projects, childrenByParent);

  const rows: GanttRow[] = [];

  function walk(project: ProjectOut, depth: number): void {
    const kids = childrenByParent[project.id] ?? [];
    const isExpandable = kids.length > 0;
    const isExpanded = isExpandable && expanded.has(project.id);
    const extent = extents.get(project.id) ?? EMPTY_EXTENT;
    rows.push(
      buildProjectRow(
        project,
        depth,
        isExpandable,
        isExpanded,
        kids.length,
        extent,
      ),
    );
    if (isExpanded && depth < MAX_TREE_DEPTH) {
      for (const kid of kids) walk(kid, depth + 1);
    }
  }

  if (options?.groupBy === "kind") {
    const rootsByKind = groupBy(roots, (p): string => p.kind ?? OTHER_KIND_KEY);
    const orderedKinds: string[] = [...projectKindValues, OTHER_KIND_KEY];
    for (const kind of orderedKinds) {
      const kindRoots = rootsByKind[kind];
      if (kindRoots == null || kindRoots.length === 0) continue;
      rows.push({
        kind: "group",
        id: `group:${kind}`,
        label: kindLabel(kind),
        count: kindRoots.length,
      });
      for (const root of kindRoots) walk(root, 0);
    }
  } else {
    for (const root of roots) walk(root, 0);
  }

  const unscheduled = roots.filter((p) => {
    const extent = extents.get(p.id) ?? EMPTY_EXTENT;
    return ownStartDay(p) == null && ownEndDay(p) == null && extent.min == null;
  });

  return {
    rows,
    unscheduled,
    extent: globalExtent(projects),
    activeExtent: globalExtent(projects.filter((p) => p.status !== "done")),
  };
}

// ---------------------------------------------------------------------------
// Surface B — single project detail
// ---------------------------------------------------------------------------

export interface ProjectRowsResult {
  rows: GanttRow[];
  unscheduled: TaskOut[];
  extent: DayRange | null;
}

export function buildProjectRows(
  rootId: string,
  subtreeProjects: ProjectOut[],
  tasks: TaskOut[],
  expanded: ReadonlySet<string>,
): ProjectRowsResult {
  const nonRootProjects = subtreeProjects.filter((p) => p.id !== rootId);
  const idSet = new Set(nonRootProjects.map((p) => p.id));
  const parentKey = (p: ProjectOut): string =>
    p.parentProjectId != null && idSet.has(p.parentProjectId)
      ? p.parentProjectId
      : rootId;
  const childrenByParent = groupBy(nonRootProjects, parentKey);
  const extents = computeSubtreeExtents(nonRootProjects, childrenByParent);
  const taskById = keyBy(tasks, (t) => t.id);

  function datedTaskRows(ownerId: string, depth: number): GanttTaskRow[] {
    const rows: GanttTaskRow[] = [];
    const topLevel = tasks.filter(
      (t) =>
        t.projectId === ownerId &&
        t.dueDate != null &&
        !(t.parentTaskId != null && taskById[t.parentTaskId] != null),
    );
    for (const task of topLevel) {
      rows.push(buildTaskRow(task, depth));
      const subtasks = tasks.filter(
        (st) => st.parentTaskId === task.id && st.dueDate != null,
      );
      for (const subtask of subtasks)
        rows.push(buildTaskRow(subtask, depth + 1));
    }
    return rows;
  }

  const rows: GanttRow[] = [];

  function walkSubProject(project: ProjectOut, depth: number): void {
    const kids = childrenByParent[project.id] ?? [];
    const hasOwnTasks = tasks.some(
      (t) => t.projectId === project.id && t.dueDate != null,
    );
    const expandable = kids.length > 0 || hasOwnTasks;
    const isExpanded = expandable && expanded.has(project.id);
    const extent = extents.get(project.id) ?? EMPTY_EXTENT;
    rows.push(
      buildProjectRow(
        project,
        depth,
        expandable,
        isExpanded,
        kids.length,
        extent,
      ),
    );
    if (isExpanded) {
      rows.push(...datedTaskRows(project.id, depth + 1));
      if (depth < MAX_TREE_DEPTH) {
        for (const kid of kids) walkSubProject(kid, depth + 1);
      }
    }
  }

  // The root's own direct tasks render at depth 0 — the root project itself
  // isn't a row here (its detail page already frames it).
  rows.push(...datedTaskRows(rootId, 0));
  const rootLevelSubProjects = childrenByParent[rootId] ?? [];
  for (const sub of rootLevelSubProjects) walkSubProject(sub, 0);

  const unscheduled = tasks.filter((t) => t.dueDate == null);

  let extent = EMPTY_EXTENT;
  for (const p of subtreeProjects) {
    extent = considerInto(considerInto(extent, ownStartDay(p)), ownEndDay(p));
  }
  for (const t of tasks) {
    if (t.dueDate == null) continue;
    const start = toDayIndex(t.dueDate);
    const end = t.dueEndDate ? toDayIndex(t.dueEndDate) : start;
    extent = considerInto(considerInto(extent, start), end);
  }

  return {
    rows,
    unscheduled,
    extent:
      extent.min != null && extent.max != null
        ? { startDay: extent.min, endDay: extent.max }
        : null,
  };
}
