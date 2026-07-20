/**
 * `list_actionable_tasks` — the computed "what can I actually do" read.
 *
 * A live (non-deleted), non-`done` task is blocked when ANY of:
 *   (a) its own status is `blocked` (manual flag)                — kind "manual"
 *   (b) it has an open `taskDependency` edge to a live, non-done
 *       blocker task                                             — kind "task"
 *   (c) its `projectId` is set and that project has an open
 *       `projectDependency` edge to a live, non-done blocker
 *       project                                                  — kind "project"
 *
 * Actionable = live, status in {not_started, in_progress, later}, zero
 * blocked reasons. Every blocked reason (task/project kind) carries a
 * transitive "why" chain: starting at the nearest blocker, follow the FIRST
 * open edge at each hop (one representative path, not all paths), switching
 * from task nodes to project nodes when a task's own blockage comes from its
 * project's edge. Depth-capped and cycle-guarded (cross-pair cycles are
 * possible even though a single entity can't be blocked by itself — see
 * `replaceDependencyEdges`'s SELF_DEPENDENCY guard).
 *
 * Single-user scale: everything is batch-loaded (4 queries — live open
 * tasks, all task edges, live open projects, all project edges — plus one
 * grouped subtask-count query) and computed in TS, no per-row queries.
 *
 * Subtask rows (`parentTaskId` set) are excluded from both `actionable` and
 * `blocked` — a checklist item is represented via its parent, not
 * independently. They still participate in `tasksById`/`taskEdgesByOwner`, so
 * a why-chain can walk through one if an edge points at it.
 */
import type { ProjectId, TaskId } from "@cubby/schemas/identifiers";
import type {
  ActionableTasksOut,
  BlockedReason,
  BlockedTaskOut,
  ProjectStatus,
  TaskStatus,
} from "@cubby/schemas/project";
import { and, asc, ne } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  project,
  projectDependency,
  task,
  taskDependency,
} from "~/server/db/schema";
import { getDb, notDeleted, relations } from "~/server/repo/database-helpers";
import { taskSubtaskCounts } from "./crud";
import { dbTaskToAPI } from "./helpers";

/** The subset of a live, non-done task's fields the chain walk needs. */
type OpenTaskNode = {
  id: TaskId;
  name: string;
  status: TaskStatus;
  projectId: ProjectId | null;
};

/** The subset of a live, non-done project's fields the chain walk needs. */
type OpenProjectNode = {
  id: ProjectId;
  name: string;
  status: ProjectStatus;
};

type ChainNode = BlockedReason["chain"][number];

const MAX_CHAIN_DEPTH = 10;

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
      const t = tasksById.get(currentId as TaskId);
      if (!t) break;
      chain.push({ id: t.id, name: t.name, status: t.status, type: "task" });

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

    const p = projectsById.get(currentId as ProjectId);
    if (!p) break;
    chain.push({ id: p.id, name: p.name, status: p.status, type: "project" });

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

export async function listActionableTasks(
  db: Database,
): Promise<ActionableTasksOut> {
  const [openTaskRows, taskEdgeRows, openProjectRows, projectEdgeRows] =
    await Promise.all([
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
        .select({ id: project.id, name: project.name, status: project.status })
        .from(project)
        .where(and(notDeleted(project), ne(project.status, "done"))),
      getDb(db)
        .select({
          projectId: projectDependency.projectId,
          blockedByProjectId: projectDependency.blockedByProjectId,
        })
        .from(projectDependency)
        .orderBy(asc(projectDependency.createdAt), asc(projectDependency.id)),
    ]);

  const tasksById = new Map<TaskId, OpenTaskNode>(
    openTaskRows.map((row) => [
      row.id,
      {
        id: row.id,
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

  // Subtask counts must include done subtasks, which `openTaskRows` (non-done
  // only) can't supply — a separate grouped query over ALL live subtasks.
  const subtaskCounts = await taskSubtaskCounts(
    db,
    openTaskRows.map((row) => row.id),
  );

  const actionable: ActionableTasksOut["actionable"] = [];
  const blocked: BlockedTaskOut[] = [];

  for (const row of openTaskRows) {
    // Checklist items are represented via their parent, not surfaced as
    // independent actionable/blocked rows (they can still appear inside a
    // why-chain below, via `tasksById`/`taskEdgesByOwner` — those stay
    // unfiltered).
    if (row.parentTaskId) continue;

    const counts = subtaskCounts.get(row.id);
    const taskOutRow = dbTaskToAPI(
      row,
      blockedByIds.get(row.id) ?? [],
      blockingIds.get(row.id) ?? [],
      counts?.count ?? 0,
      counts?.doneCount ?? 0,
    );

    const reasons: BlockedReason[] = [];

    if (row.status === "blocked") {
      reasons.push({ kind: "manual", chain: [] });
    }

    for (const blockerId of taskEdgesByOwner.get(row.id) ?? []) {
      if (!tasksById.has(blockerId)) continue; // not live/non-done -> not open
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

    if (row.projectId && projectsById.has(row.projectId)) {
      for (const blockerProjectId of projectEdgesByOwner.get(row.projectId) ??
        []) {
        if (!projectsById.has(blockerProjectId)) continue;
        reasons.push({
          kind: "project",
          chain: buildChain(
            blockerProjectId,
            "project",
            `project:${row.projectId}`,
            tasksById,
            projectsById,
            taskEdgesByOwner,
            projectEdgesByOwner,
          ),
        });
      }
    }

    if (reasons.length === 0) {
      actionable.push({ ...taskOutRow, isLater: row.status === "later" });
    } else {
      blocked.push({ task: taskOutRow, reasons });
    }
  }

  return { actionable, blocked };
}
