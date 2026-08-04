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
import { buildForest, type Forest, foldForest } from "../../project-forest";
import { toDayIndex } from "./gantt-date";

export interface GanttProjectRow {
  kind: "project";
  /** The project's shortcode — the only public id post-cutover. */
  id: string;
  name: string;
  icon: string | null;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  status: ProjectStatus;
  startDay: number | null;
  endDay: number | null;
  /** Has an effective start but no effective end. */
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
  /**
   * Dominant trade of the sub-project's own tasks, when it has any — a
   * sub-project like "Kitchen: Plumbing" is itself a trade phase, so its
   * roll-up bar can carry the phase colour. `null` for portfolio-level
   * projects (which map to a kind, not a trade) and taskless sub-projects.
   */
  trade: Trade | null;
}

/** Not exported by name: consumers narrow the `GanttRow` union on `kind`
 * instead. Export it the day something genuinely needs to name it. */
interface GanttTaskRow {
  kind: "task";
  /** The task's shortcode — the only public id post-cutover. */
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

/** Sentinel kind key for projects with a null `kind`, in `groupBy: "kind"` mode. */
const OTHER_KIND_KEY = "other";

// Named "own*Day" for historical reasons (pre-dating the derived date
// window) — these now read the EFFECTIVE bound (override when set, else
// rolled up from the project's own tasks/expenses + live sub-projects), not
// the raw `startDate`/`endDate` override columns. `computeSubtreeExtents`
// below still walks the client-side tree on top of this: the server's own
// `dates.effectiveStart/End` already folds in live descendants, but the
// client tree here can be chip-filtered to a different subset (e.g. a status
// filter that drops a sub-project), so the extent still needs recomputing
// over whatever's actually visible.
function ownStartDay(project: ProjectOut): number | null {
  return project.dates.effectiveStart
    ? toDayIndex(project.dates.effectiveStart)
    : null;
}

function ownEndDay(project: ProjectOut): number | null {
  return project.dates.effectiveEnd
    ? toDayIndex(project.dates.effectiveEnd)
    : null;
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
 * Each node's own-effective-dates min/max folded over itself + every
 * descendant. One post-order pass over the whole node set, O(n) — every node
 * is a starting point, so a node in a cycle (unreachable from the forest's
 * roots) still gets an extent, and `foldForest`'s emit-once rule makes the
 * repeat starts free.
 */
function computeSubtreeExtents(
  nodes: readonly ProjectOut[],
  forest: Forest<ProjectOut>,
): Map<string, Extent> {
  const extents = new Map<string, Extent>();
  foldForest<ProjectOut, Extent>(
    forest,
    (node, childExtents) => {
      let extent = considerInto(
        considerInto(EMPTY_EXTENT, ownStartDay(node)),
        ownEndDay(node),
      );
      for (const child of childExtents) {
        extent = considerInto(considerInto(extent, child.min), child.max);
      }
      extents.set(node.id, extent);
      return extent;
    },
    { roots: nodes },
  );
  return extents;
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
  // An open-ended bar (start, no end) already renders to the window edge, so a
  // descendant ending *after* the start isn't a meaningful extension — only a
  // descendant starting *earlier* is. Treat the end as unbounded so we don't
  // draw a spurious right-side whisker over an already open-ended bar, AND clip
  // the emitted envelope's end to the bar's own start so even a genuine
  // left-extension whisker doesn't put a right end-cap mid-bar.
  const openEnded = ownStart != null && ownEnd == null;
  const effectiveEnd = openEnded
    ? Number.POSITIVE_INFINITY
    : (ownEnd ?? ownStart ?? extent.max);
  const startsEarlier = extent.min < effectiveStart;
  const endsLater = extent.max > effectiveEnd;
  if (!startsEarlier && !endsLater) return null;
  return {
    startDay: extent.min,
    endDay: openEnded ? effectiveStart : extent.max,
  };
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
  trade: Trade | null = null,
): GanttProjectRow {
  const startDay = ownStartDay(project);
  const endDay = ownEndDay(project);
  return {
    kind: "project",
    id: project.id,
    name: project.name,
    icon: project.icon,
    depth,
    expandable,
    expanded,
    status: project.status,
    startDay,
    endDay,
    openEnded:
      project.dates.effectiveStart != null &&
      project.dates.effectiveEnd == null,
    envelope: computeEnvelope(startDay, endDay, extent),
    progress: computeProgress(project, childCount),
    blockedByIds: project.blockedByIds,
    blockingIds: project.blockingIds,
    childCount,
    trade,
  };
}

/**
 * The most common trade among a project's own dated-or-undated tasks, or null
 * when it has none. A sub-project is typically single-trade ("Kitchen:
 * Plumbing"), so the mode is that trade; ties break by first-seen.
 */
function dominantTrade(
  projectId: string,
  tasksByProject: Record<string, TaskOut[]>,
): Trade | null {
  const own = tasksByProject[projectId] ?? [];
  if (own.length === 0) return null;
  const counts = new Map<Trade, number>();
  let best: Trade | null = null;
  let bestCount = 0;
  for (const t of own) {
    const next = (counts.get(t.trade) ?? 0) + 1;
    counts.set(t.trade, next);
    if (next > bestCount) {
      bestCount = next;
      best = t.trade;
    }
  }
  return best;
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
  // Orphan promotion (a project whose parent was filtered out of `projects`
  // renders as a root instead of vanishing), the depth cap, and the cycle
  // guard all come from the shared forest core.
  const forest = buildForest(projects);
  const { childrenByParent } = forest;
  const roots = forest.roots;
  const extents = computeSubtreeExtents(projects, forest);

  // Pre-order flat rows: each node folds to itself followed by its walked
  // descendants. `cyclicRoots` are deliberately NOT walked — a project in a
  // parent loop has no honest place on a timeline, so it stays off the chart
  // (the WBS table makes the opposite call and promotes them).
  const walkRoots = (rootSet: readonly ProjectOut[]): GanttRow[] =>
    foldForest<ProjectOut, GanttRow[]>(
      forest,
      (node, childRows, depth) => {
        const kids = childrenByParent.get(node.id) ?? [];
        const isExpandable = kids.length > 0;
        const isExpanded = isExpandable && expanded.has(node.id);
        const extent = extents.get(node.id) ?? EMPTY_EXTENT;
        return [
          buildProjectRow(
            node,
            depth,
            isExpandable,
            isExpanded,
            kids.length,
            extent,
          ),
          ...childRows.flat(),
        ];
      },
      { roots: rootSet, descend: (node) => expanded.has(node.id) },
    ).flat();

  const rows: GanttRow[] = [];

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
      // Safe to walk each kind group separately: the groups partition `roots`,
      // and a descendant is only ever reachable from its own root.
      rows.push(...walkRoots(kindRoots));
    }
  } else {
    rows.push(...walkRoots(roots));
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
  // The root project isn't a node here, so its direct children fall out as the
  // forest's roots — the same set the old explicit `rootId` parent key produced.
  const forest = buildForest(nonRootProjects);
  const { childrenByParent } = forest;
  const extents = computeSubtreeExtents(nonRootProjects, forest);
  const taskById = keyBy(tasks, (t) => t.id);
  // Own tasks per project id, for the sub-project row's dominant-trade colour.
  const tasksByProject = groupBy(
    tasks.filter((t) => t.projectId != null),
    (t) => t.projectId as string,
  );

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

  // Pre-order: the sub-project row, then (when expanded) its own dated tasks,
  // then its walked sub-projects.
  const subProjectRows = foldForest<ProjectOut, GanttRow[]>(
    forest,
    (node, childRows, depth) => {
      const kids = childrenByParent.get(node.id) ?? [];
      const hasOwnTasks = tasks.some(
        (t) => t.projectId === node.id && t.dueDate != null,
      );
      const expandable = kids.length > 0 || hasOwnTasks;
      const isExpanded = expandable && expanded.has(node.id);
      return [
        buildProjectRow(
          node,
          depth,
          expandable,
          isExpanded,
          kids.length,
          extents.get(node.id) ?? EMPTY_EXTENT,
          dominantTrade(node.id, tasksByProject),
        ),
        ...(isExpanded ? datedTaskRows(node.id, depth + 1) : []),
        ...childRows.flat(),
      ];
    },
    { descend: (node) => expanded.has(node.id) },
  ).flat();

  // The root's own direct tasks render at depth 0 — the root project itself
  // isn't a row here (its detail page already frames it).
  rows.push(...datedTaskRows(rootId, 0));
  rows.push(...subProjectRows);

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
