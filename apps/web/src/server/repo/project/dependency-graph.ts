/** Complete, non-paginated work graph for the graph explorer. */
import type { ProjectId, TaskId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProjectDependencyGraph,
  ProjectGraphEdge,
  ProjectGraphNode,
} from "@cubby/schemas/project-dependency-graph";

import type { Database } from "~/server/db";
import {
  project,
  projectDependency,
  task,
  taskDependency,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { effectiveTaskProjectSql } from "~/server/repo/task-project-inheritance";

type ProjectRow = {
  id: ProjectId;
  shortcode: string;
  name: string;
  status: "planning" | "not_started" | "in_progress" | "done";
  parentProjectId: ProjectId | null;
  locations: string[];
};
type TaskRow = {
  id: TaskId;
  shortcode: string;
  name: string;
  status: "not_started" | "later" | "in_progress" | "blocked" | "done";
  projectId: ProjectId | null;
  parentTaskId: TaskId | null;
  dueDate: string | null;
  dueEndDate: string | null;
};
type ProjectDependencyRow = {
  projectId: ProjectId;
  blockedByProjectId: ProjectId;
};
type TaskDependencyRow = { taskId: TaskId; blockedByTaskId: TaskId };
type GraphRows = {
  projects: ProjectRow[];
  tasks: TaskRow[];
  projectDependencies: ProjectDependencyRow[];
  taskDependencies: TaskDependencyRow[];
};
type GraphScope = {
  ownedProjects: Set<ProjectId>;
  ownedTasks: Set<TaskId>;
  selectedProjects: Set<ProjectId>;
  selectedTasks: Set<TaskId>;
};
type GraphCodes = {
  projects: Map<ProjectId, ProjectGraphNode["id"]>;
  tasks: Map<TaskId, ProjectGraphNode["id"]>;
};

const fetchGraphRows = async (db: Database): Promise<GraphRows> => {
  const dbClient = getDb(db);
  const [projects, tasks, projectDependencies, taskDependencies] =
    await Promise.all([
      dbClient.query.project.findMany({
        where: notDeleted(project),
        columns: {
          id: true,
          shortcode: true,
          name: true,
          status: true,
          parentProjectId: true,
          locations: true,
        },
      }),
      dbClient
        .select({
          id: task.id,
          shortcode: task.shortcode,
          name: task.name,
          status: task.status,
          projectId: effectiveTaskProjectSql("Task"),
          parentTaskId: task.parentTaskId,
          dueDate: task.dueDate,
          dueEndDate: task.dueEndDate,
        })
        .from(task)
        .where(notDeleted(task)),
      dbClient
        .select({
          projectId: projectDependency.projectId,
          blockedByProjectId: projectDependency.blockedByProjectId,
        })
        .from(projectDependency),
      dbClient
        .select({
          taskId: taskDependency.taskId,
          blockedByTaskId: taskDependency.blockedByTaskId,
        })
        .from(taskDependency),
    ]);
  return { projects, tasks, projectDependencies, taskDependencies };
};

const byId = <Id extends string, Row extends { id: Id }>(rows: Row[]) =>
  new Map<Id, Row>(rows.map((row) => [row.id, row]));

const projectSubtree = (
  scopeProjectId: ProjectId | undefined,
  projectRows: ProjectRow[],
  projects: Map<ProjectId, ProjectRow>,
) => {
  if (!scopeProjectId) return new Set(projectRows.map((row) => row.id));
  const ids = new Set<ProjectId>([scopeProjectId]);
  for (const row of projectRows) {
    let parent = row.parentProjectId;
    const seen = new Set<ProjectId>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (parent === scopeProjectId) {
        ids.add(row.id);
        break;
      }
      parent = projects.get(parent)?.parentProjectId ?? null;
    }
  }
  return ids;
};

const taskIdsForScope = (
  scopeProjectId: ProjectId | undefined,
  taskRows: TaskRow[],
  projectIds: Set<ProjectId>,
) =>
  new Set<TaskId>(
    scopeProjectId
      ? taskRows
          .filter((row) => row.projectId && projectIds.has(row.projectId))
          .map((row) => row.id)
      : taskRows.map((row) => row.id),
  );

const addProjectDependencyContext = (
  owned: Set<ProjectId>,
  selected: Set<ProjectId>,
  rows: ProjectDependencyRow[],
  projects: Map<ProjectId, ProjectRow>,
) => {
  for (const { projectId, blockedByProjectId } of rows) {
    if (owned.has(projectId) && projects.has(blockedByProjectId)) {
      selected.add(blockedByProjectId);
    }
    if (owned.has(blockedByProjectId) && projects.has(projectId)) {
      selected.add(projectId);
    }
  }
};

const addTaskDependencyContext = (
  owned: Set<TaskId>,
  selected: Set<TaskId>,
  rows: TaskDependencyRow[],
  tasks: Map<TaskId, TaskRow>,
) => {
  for (const { taskId, blockedByTaskId } of rows) {
    if (owned.has(taskId) && tasks.has(blockedByTaskId)) {
      selected.add(blockedByTaskId);
    }
    if (owned.has(blockedByTaskId) && tasks.has(taskId)) {
      selected.add(taskId);
    }
  }
};

const addHierarchyContext = (
  selectedProjects: Set<ProjectId>,
  selectedTasks: Set<TaskId>,
  projects: Map<ProjectId, ProjectRow>,
  tasks: Map<TaskId, TaskRow>,
) => {
  // Dependency context can introduce an external task whose parent/project in
  // turn has another ancestor. Close the hierarchy before emitting codes so
  // every selected node has a visible parent chain.
  let changed = true;
  while (changed) {
    changed = false;
    for (const taskId of selectedTasks) {
      const row = tasks.get(taskId);
      if (!row) continue;
      if (
        row.parentTaskId &&
        tasks.has(row.parentTaskId) &&
        !selectedTasks.has(row.parentTaskId)
      ) {
        selectedTasks.add(row.parentTaskId);
        changed = true;
      }
      if (
        row.projectId &&
        projects.has(row.projectId) &&
        !selectedProjects.has(row.projectId)
      ) {
        selectedProjects.add(row.projectId);
        changed = true;
      }
    }
    for (const projectId of selectedProjects) {
      let parent = projects.get(projectId)?.parentProjectId ?? null;
      while (parent && !selectedProjects.has(parent)) {
        selectedProjects.add(parent);
        changed = true;
        parent = projects.get(parent)?.parentProjectId ?? null;
      }
    }
  }
};

const graphScope = (
  scopeProjectId: ProjectId | undefined,
  rows: GraphRows,
  projects: Map<ProjectId, ProjectRow>,
  tasks: Map<TaskId, TaskRow>,
): GraphScope => {
  const ownedProjects = projectSubtree(scopeProjectId, rows.projects, projects);
  const ownedTasks = taskIdsForScope(scopeProjectId, rows.tasks, ownedProjects);
  const selectedProjects = new Set(ownedProjects);
  const selectedTasks = new Set(ownedTasks);
  addProjectDependencyContext(
    ownedProjects,
    selectedProjects,
    rows.projectDependencies,
    projects,
  );
  addTaskDependencyContext(
    ownedTasks,
    selectedTasks,
    rows.taskDependencies,
    tasks,
  );
  addHierarchyContext(selectedProjects, selectedTasks, projects, tasks);
  return { ownedProjects, ownedTasks, selectedProjects, selectedTasks };
};

const graphCodes = (
  scope: GraphScope,
  projects: Map<ProjectId, ProjectRow>,
  tasks: Map<TaskId, TaskRow>,
): GraphCodes => ({
  projects: new Map(
    [...projects]
      .filter(([id]) => scope.selectedProjects.has(id))
      .map(([id, row]) => [id, parseShortcodeFor("project", row.shortcode)]),
  ),
  tasks: new Map(
    [...tasks]
      .filter(([id]) => scope.selectedTasks.has(id))
      .map(([id, row]) => [id, parseShortcodeFor("task", row.shortcode)]),
  ),
});

const projectNodes = (
  rows: ProjectRow[],
  scope: GraphScope,
  codes: GraphCodes,
): ProjectGraphNode[] =>
  rows.flatMap((row) => {
    const id = codes.projects.get(row.id);
    if (!id) return [];
    return [
      {
        id,
        kind: "project" as const,
        name: row.name,
        status: row.status,
        locations: row.locations,
        dueDate: null,
        dueEndDate: null,
        parentId: row.parentProjectId
          ? (codes.projects.get(row.parentProjectId) ?? null)
          : null,
        external: !scope.ownedProjects.has(row.id),
      },
    ];
  });

const taskNodes = (
  rows: TaskRow[],
  projects: Map<ProjectId, ProjectRow>,
  scope: GraphScope,
  codes: GraphCodes,
): ProjectGraphNode[] =>
  rows.flatMap((row) => {
    const id = codes.tasks.get(row.id);
    if (!id) return [];
    const parentId = row.parentTaskId
      ? (codes.tasks.get(row.parentTaskId) ?? null)
      : row.projectId
        ? (codes.projects.get(row.projectId) ?? null)
        : null;
    return [
      {
        id,
        kind: "task" as const,
        name: row.name,
        status: row.status,
        locations: row.projectId
          ? (projects.get(row.projectId)?.locations ?? [])
          : [],
        dueDate: row.dueDate,
        dueEndDate: row.dueEndDate,
        parentId,
        external: !scope.ownedTasks.has(row.id),
      },
    ];
  });

const appendEdge = (
  edges: ProjectGraphEdge[],
  seen: Set<string>,
  source: ProjectGraphNode["id"] | undefined,
  target: ProjectGraphNode["id"] | undefined,
  kind: ProjectGraphEdge["kind"],
) => {
  if (!source || !target) return;
  const key = `${kind}:${source}:${target}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ source, target, kind });
};

const graphEdges = (rows: GraphRows, codes: GraphCodes) => {
  const edges: ProjectGraphEdge[] = [];
  const seen = new Set<string>();
  for (const row of rows.projects) {
    appendEdge(
      edges,
      seen,
      row.parentProjectId ? codes.projects.get(row.parentProjectId) : undefined,
      codes.projects.get(row.id),
      "hierarchy",
    );
  }
  for (const row of rows.tasks) {
    const source = row.parentTaskId
      ? codes.tasks.get(row.parentTaskId)
      : row.projectId
        ? codes.projects.get(row.projectId)
        : undefined;
    appendEdge(edges, seen, source, codes.tasks.get(row.id), "hierarchy");
  }
  for (const row of rows.projectDependencies) {
    appendEdge(
      edges,
      seen,
      codes.projects.get(row.blockedByProjectId),
      codes.projects.get(row.projectId),
      "dependency",
    );
  }
  for (const row of rows.taskDependencies) {
    appendEdge(
      edges,
      seen,
      codes.tasks.get(row.blockedByTaskId),
      codes.tasks.get(row.taskId),
      "dependency",
    );
  }
  return edges;
};

/** Dependencies point from a blocker to the work it blocks, as in the Gantt. */
export const getProjectDependencyGraph = async (
  db: Database,
  scopeProjectId?: ProjectId,
): Promise<ProjectDependencyGraph> => {
  const rows = await fetchGraphRows(db);
  const projects = byId<ProjectId, ProjectRow>(rows.projects);
  const tasks = byId<TaskId, TaskRow>(rows.tasks);
  const scope = graphScope(scopeProjectId, rows, projects, tasks);
  const codes = graphCodes(scope, projects, tasks);
  return {
    nodes: [
      ...projectNodes(rows.projects, scope, codes),
      ...taskNodes(rows.tasks, projects, scope, codes),
    ],
    edges: graphEdges(rows, codes),
  };
};
