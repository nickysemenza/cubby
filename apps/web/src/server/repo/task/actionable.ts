/**
 * `list_actionable_tasks` — the computed "what can I actually do" read.
 *
 * A live (non-deleted), non-`done` task is blocked when ANY of:
 *   (a) its own status is `blocked` (manual flag)                — kind "manual"
 *   (b) it has an open `taskDependency` edge to a live, non-done
 *       blocker task                                             — kind "task"
 *   (c) its `projectId`, or ANY live ancestor of that project
 *       (walking `parentProjectId` up, arbitrary depth), has an
 *       open `projectDependency` edge to a live, non-done blocker
 *       project                                                  — kind "project"
 *
 * (c) only considers an ancestor's OWN blocked-by edges while that ancestor
 * is itself live and non-done — a `done` intermediate ancestor doesn't
 * propagate its edges (a finished phase can't still be "blocking" its own
 * sub-projects), but the walk continues past it to check further-up
 * ancestors. Reuses `projectsById` (live, non-done) as the membership test
 * for "does this candidate project's own edges count" — no separate status
 * fetch needed, just the id→parentProjectId map to walk with (see
 * `allProjectParentRowsForActionable`).
 *
 * Actionable = live, status in {not_started, in_progress, later}, zero
 * blocked reasons — partitioned into `next` (not_started/in_progress) and
 * `later` (later) rather than one array with an `isLater` flag, since
 * Next/Later render as distinct UI sections. Every blocked reason
 * (task/project kind) carries a transitive "why" chain: starting at the
 * nearest blocker, follow the FIRST open edge at each hop (one
 * representative path, not all paths), switching from task nodes to project
 * nodes when a task's own blockage comes from its project's (or an ancestor
 * project's) edge — the chain itself never includes the ancestor hops, only
 * the blocker side. Depth-capped and cycle-guarded (cross-pair cycles are
 * possible even though a single entity can't be blocked by itself — see
 * `replaceDependencyEdges`'s SELF_DEPENDENCY guard).
 *
 * Ordering: `next` sorts overdue-first (effective due date `dueEndDate ??
 * dueDate` before today), then effective due date ascending (nulls last),
 * then `in_progress` before `not_started`, then name ascending. `later`
 * sorts by due date ascending (nulls last, using the plain `dueDate` — a
 * someday item's range is less meaningful than a committed task's), then
 * `updatedAt` descending. `blocked` sorts by effective due date ascending
 * (nulls last), then name ascending.
 *
 * Single-user scale: everything is batch-loaded (5 queries — live open
 * tasks, all task edges, live open projects, all project edges, all live
 * projects' id/parentProjectId pairs for the ancestor walk — plus one
 * grouped subtask-count query) and computed in TS, no per-row queries.
 *
 * Subtask rows (`parentTaskId` set) are excluded from both `actionable` and
 * `blocked` — a checklist item is represented via its parent, not
 * independently. They still participate in `tasksById`/`taskEdgesByOwner`, so
 * a why-chain can walk through one if an edge points at it.
 */
import { entityRefKey } from "@cubby/schemas/entity";
import {
  type ProjectId,
  parseEntityId,
  parseShortcodeFor,
  type TaskId,
  type TaskShortcode,
} from "@cubby/schemas/identifiers";
import type {
  ActionableTaskOut,
  ActionableTasksOut,
  BlockedReason,
  BlockedTaskOut,
  ProjectStatus,
  TaskFilters,
  TaskStatus,
} from "@cubby/schemas/project";
import { and, asc, ne } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import { effectiveTaskDueDate } from "~/lib/task-dates";
import type { Database } from "~/server/db";
import {
  project,
  projectDependency,
  task,
  taskDependency,
} from "~/server/db/schema";
import { getDb, notDeleted, relations } from "~/server/repo/database-helpers";
import {
  type EntityRef,
  lookupShortcodes,
} from "~/server/repo/shortcode-resolver";

import { hydrateTaskInheritanceRows } from "../task-project-inheritance";
import { taskSubtaskCounts } from "./crud";
import { dbTaskToAPI } from "./helpers";
import { taskList } from "./lookup";

/** The subset of a live, non-done task's fields the chain walk needs. */
type OpenTaskNode = {
  id: TaskId;
  shortcode: string;
  name: string;
  status: TaskStatus;
  projectId: ProjectId | null;
};

/** The subset of a live, non-done project's fields the chain walk needs. */
type OpenProjectNode = {
  id: ProjectId;
  shortcode: string;
  name: string;
  status: ProjectStatus;
};

type ChainNode = BlockedReason["chain"][number];

const MAX_CHAIN_DEPTH = 10;
/** Defensive cap on the ancestor walk — mirrors project/subtree.ts's
 * `MAX_PROJECT_TREE_DEPTH`. A well-formed tree (cycles rejected at
 * create/update time — see repo/project/crud.ts) never gets close to it. */
const MAX_ANCESTOR_DEPTH = 100;

/**
 * `startId`'s live ancestor project ids, walking `parentProjectId` up
 * (nearest first), depth-capped and cycle-guarded via a visited set. Does
 * NOT filter by done/non-done — the caller checks that against `projectsById`
 * per candidate (see the module doc comment on why a done ancestor doesn't
 * propagate its edges but the walk still continues past it).
 */
function ancestorProjectIds(
  startId: ProjectId,
  parentProjectById: Map<ProjectId, ProjectId | null>,
): ProjectId[] {
  const out: ProjectId[] = [];
  const visited = new Set<ProjectId>([startId]);
  let currentId = parentProjectById.get(startId) ?? null;
  let hops = 0;
  while (currentId && hops < MAX_ANCESTOR_DEPTH) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    out.push(currentId);
    currentId = parentProjectById.get(currentId) ?? null;
    hops++;
  }
  return out;
}

/**
 * Walk one representative path from `startId` (the nearest blocker),
 * following the first open edge at each hop: task → task via
 * `taskEdgesByOwner`, falling back to task → project via the task's own
 * `projectId` + `projectEdgesByOwner` once no further task edge is open;
 * project → project via `projectEdgesByOwner`. Cycle-guarded with a
 * `type:id` visited set seeded with the entity the reason belongs to (so the
 * chain never loops back to the task/project it's explaining), depth-capped
 * at {@link MAX_CHAIN_DEPTH}.
 */
function buildChain(
  startId: string,
  startType: "task" | "project",
  seedVisitedKey: string,
  tasksById: Map<TaskId, OpenTaskNode>,
  projectsById: Map<ProjectId, OpenProjectNode>,
  taskEdgesByOwner: Map<TaskId, TaskId[]>,
  projectEdgesByOwner: Map<ProjectId, ProjectId[]>,
): ChainNode[] {
  const chain: ChainNode[] = [];
  const visited = new Set<string>([seedVisitedKey]);
  let currentId = startId;
  let currentType: "task" | "project" = startType;

  for (let hop = 0; hop < MAX_CHAIN_DEPTH; hop++) {
    const key = `${currentType}:${currentId}`;
    if (visited.has(key)) break;
    visited.add(key);

    if (currentType === "task") {
      const t = tasksById.get(parseEntityId("task", currentId));
      if (!t) break;
      chain.push({
        id: t.shortcode,
        name: t.name,
        status: t.status,
        type: "task",
      });

      const nextTask = taskEdgesByOwner
        .get(t.id)
        ?.find((blockerId) => tasksById.has(blockerId));
      if (nextTask) {
        currentId = nextTask;
        currentType = "task";
        continue;
      }

      const ownProject = t.projectId
        ? projectsById.get(t.projectId)
        : undefined;
      const nextProject = ownProject
        ? projectEdgesByOwner
            .get(ownProject.id)
            ?.find((blockerId) => projectsById.has(blockerId))
        : undefined;
      if (nextProject) {
        currentId = nextProject;
        currentType = "project";
        continue;
      }
      break;
    }

    const p = projectsById.get(parseEntityId("project", currentId));
    if (!p) break;
    chain.push({
      id: p.shortcode,
      name: p.name,
      status: p.status,
      type: "project",
    });

    const nextProject = projectEdgesByOwner
      .get(p.id)
      ?.find((blockerId) => projectsById.has(blockerId));
    if (!nextProject) break;
    currentId = nextProject;
    currentType = "project";
  }

  return chain;
}

/** Push `value` onto `map.get(key)`, creating the array on first insert. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) {
    arr.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * `next` order: overdue (effective due date before `today`) first, then
 * effective due date ascending (nulls last), then `in_progress` before
 * `not_started`, then name ascending.
 */
function compareNext(
  a: ActionableTaskOut,
  b: ActionableTaskOut,
  today: string,
): number {
  const aDue = effectiveTaskDueDate(a);
  const bDue = effectiveTaskDueDate(b);
  const aOverdue = aDue != null && aDue < today;
  const bOverdue = bDue != null && bDue < today;
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
  if (aDue !== bDue) {
    if (aDue == null) return 1;
    if (bDue == null) return -1;
    return aDue.localeCompare(bDue);
  }
  if (a.status !== b.status) {
    return a.status === "in_progress" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/**
 * `later` order: plain due date ascending (nulls last — someday items'
 * ranges are less meaningful than a committed task's, so this uses `dueDate`
 * rather than the effective/range date), then `updatedAt` descending.
 */
function compareLater(a: ActionableTaskOut, b: ActionableTaskOut): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate == null) return 1;
    if (b.dueDate == null) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  }
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

/** `blocked` order: effective due date ascending (nulls last), then name ascending. */
function compareBlocked(a: BlockedTaskOut, b: BlockedTaskOut): number {
  const aDue = effectiveTaskDueDate(a.task);
  const bDue = effectiveTaskDueDate(b.task);
  if (aDue !== bDue) {
    if (aDue == null) return 1;
    if (bDue == null) return -1;
    return aDue.localeCompare(bDue);
  }
  return a.task.name.localeCompare(b.task.name);
}

export async function listActionableTasks(
  db: Database,
  filters: TaskFilters = {},
): Promise<ActionableTasksOut> {
  // Membership is delegated to the ordinary list predicate. The actionable
  // renderer then adds its disclosed open/top-level semantics while retaining
  // the full graph below to explain why a matching row is blocked.
  const matching = await taskList(
    db,
    { ...filters, completion: "open", topLevelOnly: true },
    [],
    { pageIndex: 0, pageSize: 100_000 },
  );
  const matchingShortcodes = new Set<string>(
    matching.data.map((row) => row.id),
  );
  if (matchingShortcodes.size === 0) {
    return { next: [], later: [], blocked: [] };
  }

  const [
    openTaskRows,
    taskEdgeRows,
    openProjectRows,
    projectEdgeRows,
    allProjectParentRows,
  ] = await Promise.all([
    getDb(db).query.task.findMany({
      where: and(notDeleted(task), ne(task.status, "done")),
      ...relations.task.withProject,
    }),
    getDb(db)
      .select({
        taskId: taskDependency.taskId,
        blockedByTaskId: taskDependency.blockedByTaskId,
      })
      .from(taskDependency)
      .orderBy(asc(taskDependency.createdAt), asc(taskDependency.id)),
    getDb(db)
      .select({
        id: project.id,
        shortcode: project.shortcode,
        name: project.name,
        status: project.status,
      })
      .from(project)
      .where(and(notDeleted(project), ne(project.status, "done"))),
    getDb(db)
      .select({
        projectId: projectDependency.projectId,
        blockedByProjectId: projectDependency.blockedByProjectId,
      })
      .from(projectDependency)
      .orderBy(asc(projectDependency.createdAt), asc(projectDependency.id)),
    // ALL live projects (any status) — just enough to walk `parentProjectId`
    // up from a task's project; done-ness is checked separately against
    // `projectsById` per ancestor (see module doc comment).
    getDb(db)
      .select({ id: project.id, parentProjectId: project.parentProjectId })
      .from(project)
      .where(notDeleted(project)),
  ]);

  const hydratedOpenTaskRows = await hydrateTaskInheritanceRows(
    db,
    openTaskRows,
  );
  const tasksById = new Map<TaskId, OpenTaskNode>(
    hydratedOpenTaskRows.map((row) => [
      row.id,
      {
        id: row.id,
        shortcode: row.shortcode,
        name: row.name,
        status: row.status,
        projectId: row.projectId,
      },
    ]),
  );
  const projectsById = new Map<ProjectId, OpenProjectNode>(
    openProjectRows.map((row) => [row.id, row]),
  );

  // blockedByIds/blockingIds mirror `taskDependencyIds`' semantics (raw edge
  // ids, regardless of the other side's live/done state) — built here from
  // the same edge rows instead of a second pair of queries.
  const blockedByIds = new Map<TaskId, TaskId[]>();
  const blockingIds = new Map<TaskId, TaskId[]>();
  // Edges grouped by owner, in the fetch's stable (createdAt, id) order —
  // `.find(...)` over this array is the "first open edge" the chain walk uses.
  const taskEdgesByOwner = new Map<TaskId, TaskId[]>();

  for (const edge of taskEdgeRows) {
    pushTo(blockedByIds, edge.taskId, edge.blockedByTaskId);
    pushTo(blockingIds, edge.blockedByTaskId, edge.taskId);
    pushTo(taskEdgesByOwner, edge.taskId, edge.blockedByTaskId);
  }

  const projectEdgesByOwner = new Map<ProjectId, ProjectId[]>();
  for (const edge of projectEdgeRows) {
    pushTo(projectEdgesByOwner, edge.projectId, edge.blockedByProjectId);
  }

  const parentProjectById = new Map<ProjectId, ProjectId | null>(
    allProjectParentRows.map((row) => [row.id, row.parentProjectId]),
  );

  // Subtask counts must include done subtasks, which `openTaskRows` (non-done
  // only) can't supply — a separate grouped query over ALL live subtasks.
  const subtaskCounts = await taskSubtaskCounts(
    db,
    hydratedOpenTaskRows.map((row) => row.id),
  );

  // `dbTaskToAPI` takes public ids for blockedByIds/blockingIds; the edge
  // values above are the OTHER side's uuid regardless of its open/done
  // state, so they aren't all covered by `tasksById` — one batched reverse
  // lookup for whichever ones are actually referenced.
  const referencedTaskIds = [
    ...new Set([...blockedByIds.values(), ...blockingIds.values()].flat()),
  ];
  const taskRefs: EntityRef[] = referencedTaskIds.map((id) => ({
    entity: "task",
    id,
  }));
  const taskShortcodesById = await lookupShortcodes(db, taskRefs);
  const toTaskShortcodes = (ids: TaskId[]): TaskShortcode[] =>
    ids.map((id) =>
      parseShortcodeFor(
        "task",
        taskShortcodesById.get(entityRefKey("task", id)) ?? "",
      ),
    );

  const next: ActionableTaskOut[] = [];
  const later: ActionableTaskOut[] = [];
  const blocked: BlockedTaskOut[] = [];
  const today = householdLocalDate();

  const blockedReasonsFor = (row: (typeof hydratedOpenTaskRows)[number]) => {
    const reasons: BlockedReason[] = [];
    if (row.status === "blocked") reasons.push({ kind: "manual", chain: [] });
    for (const blockerId of taskEdgesByOwner.get(row.id) ?? []) {
      if (!tasksById.has(blockerId)) continue;
      reasons.push({
        kind: "task",
        chain: buildChain(
          blockerId,
          "task",
          `task:${row.id}`,
          tasksById,
          projectsById,
          taskEdgesByOwner,
          projectEdgesByOwner,
        ),
      });
    }
    if (!row.projectId) return reasons;
    // A task inherits blockers from every live ancestor. Done ancestors are
    // skipped as blockers, but traversal continues through them.
    const candidateProjectIds = [
      row.projectId,
      ...ancestorProjectIds(row.projectId, parentProjectById),
    ];
    for (const candidateProjectId of candidateProjectIds) {
      if (!projectsById.has(candidateProjectId)) continue;
      for (const blockerProjectId of projectEdgesByOwner.get(
        candidateProjectId,
      ) ?? []) {
        if (!projectsById.has(blockerProjectId)) continue;
        reasons.push({
          kind: "project",
          chain: buildChain(
            blockerProjectId,
            "project",
            `project:${candidateProjectId}`,
            tasksById,
            projectsById,
            taskEdgesByOwner,
            projectEdgesByOwner,
          ),
        });
      }
    }
    return reasons;
  };

  const appendActionableRow = (row: (typeof hydratedOpenTaskRows)[number]) => {
    // Checklist items are represented via their parent, not surfaced as
    // independent actionable/blocked rows (they can still appear inside a
    // why-chain below, via `tasksById`/`taskEdgesByOwner` — those stay
    // unfiltered).
    if (row.parentTaskId) return;
    if (!matchingShortcodes.has(row.shortcode)) return;

    const counts = subtaskCounts.get(row.id);
    const taskOutRow = dbTaskToAPI(
      row,
      toTaskShortcodes(blockedByIds.get(row.id) ?? []),
      toTaskShortcodes(blockingIds.get(row.id) ?? []),
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );

    const reasons = blockedReasonsFor(row);

    if (reasons.length === 0) {
      if (row.status === "later") {
        later.push(taskOutRow);
      } else {
        next.push(taskOutRow);
      }
    } else {
      blocked.push({ task: taskOutRow, reasons });
    }
  };
  for (const row of hydratedOpenTaskRows) appendActionableRow(row);

  next.sort((a, b) => compareNext(a, b, today));
  later.sort(compareLater);
  blocked.sort(compareBlocked);

  return { next, later, blocked };
}
