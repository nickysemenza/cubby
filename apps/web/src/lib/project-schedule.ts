// The one place a Project or Task becomes a schedule row, shared by the server
// (the `project.schedule` report both clients draw) and the web portfolio list.
import type { ReportScheduleRow } from "@cubby/schemas/entity-report";
import type { ProjectOut, TaskOut } from "@cubby/schemas/project";

export type ProjectScheduleRow = ReportScheduleRow;

export type ProjectForSchedule = Pick<
  ProjectOut,
  "id" | "name" | "status" | "dates" | "blockedByIds" | "blockingIds"
>;

export function projectScheduleRow(
  project: ProjectForSchedule,
  depth: number,
  expandable: boolean,
): ProjectScheduleRow {
  const start = project.dates.effectiveStart;
  const end = project.dates.effectiveEnd;
  const dated = start ?? end;
  const source =
    project.dates.startSource === "derived" ||
    project.dates.endSource === "derived"
      ? " · Derived dates"
      : "";
  const segments: ProjectScheduleRow["segments"] = [];
  if (dated) {
    const segment: ProjectScheduleRow["segments"][number] = {
      id: `${project.id}:window`,
      label: project.name,
      startDate: dated,
      variant: start && end && end > start ? "range" : "milestone",
    };
    if (start && end && end >= start) segment.endDate = end;
    segments.push(segment);
  }
  const row: ProjectScheduleRow = {
    id: project.id,
    name: project.name,
    entity: "project",
    depth,
    expandable,
    meta: `Project · ${project.status.replaceAll("_", " ")}${source}`,
    metaShort: project.status.replaceAll("_", " "),
    segments,
    blockedByIds: project.blockedByIds,
    blockingIds: project.blockingIds,
  };
  if (!dated) row.noDateLabel = "No dates";
  return row;
}

type ScheduleTask = Pick<
  TaskOut,
  | "id"
  | "name"
  | "status"
  | "dueDate"
  | "dueEndDate"
  | "projectId"
  | "parentTaskId"
  | "blockedByIds"
  | "blockingIds"
>;

function taskScheduleRow(
  task: ScheduleTask,
  depth: number,
  expandable: boolean,
): ProjectScheduleRow {
  const start = task.dueDate;
  const end = task.dueEndDate;
  const dated = start ?? end;
  const segments: ProjectScheduleRow["segments"] = [];
  if (dated) {
    const segment: ProjectScheduleRow["segments"][number] = {
      id: `${task.id}:due`,
      label: start ? task.name : `${task.name} due end`,
      startDate: dated,
      variant: start && end && end > start ? "range" : "milestone",
    };
    if (start && end && end >= start) segment.endDate = end;
    segments.push(segment);
  }
  const row: ProjectScheduleRow = {
    id: task.id,
    name: task.name,
    entity: "task",
    depth,
    expandable,
    meta: `Task · ${task.status.replaceAll("_", " ")}${!start && end ? " · Due end only" : ""}`,
    metaShort: task.status.replaceAll("_", " "),
    segments,
    blockedByIds: task.blockedByIds,
    blockingIds: task.blockingIds,
  };
  if (!dated) row.noDateLabel = "No due date";
  return row;
}

/**
 * Every live descendant project and its tasks under `root`, in display
 * (pre-)order, including rows without dates. A task belongs to its project, or
 * through its parent task to that parent's owner, else to the root.
 */
export function buildDetailScheduleRows(
  root: ProjectForSchedule & Partial<Pick<ProjectOut, "parentProjectId">>,
  descendants: readonly (ProjectForSchedule &
    Pick<ProjectOut, "parentProjectId">)[],
  tasks: readonly ScheduleTask[],
): ProjectScheduleRow[] {
  const projects = [root, ...descendants.filter((item) => item.id !== root.id)];
  const projectIds = new Set(projects.map((item) => item.id));
  const childrenByProject = new Map<string, (typeof descendants)[number][]>();
  for (const item of descendants) {
    if (item.id === root.id) continue;
    if (!item.parentProjectId || !projectIds.has(item.parentProjectId))
      continue;
    const children = childrenByProject.get(item.parentProjectId) ?? [];
    children.push(item);
    childrenByProject.set(item.parentProjectId, children);
  }

  const tasksById = new Map(tasks.map((item) => [item.id, item]));
  const ownerByTask = new Map<string, string>();
  const ownerOf = (task: ScheduleTask, seen = new Set<string>()): string => {
    const cached = ownerByTask.get(task.id);
    if (cached) return cached;
    if (seen.has(task.id)) return root.id;
    seen.add(task.id);
    const owner =
      task.projectId && projectIds.has(task.projectId)
        ? task.projectId
        : task.parentTaskId && tasksById.has(task.parentTaskId)
          ? ownerOf(tasksById.get(task.parentTaskId)!, seen)
          : root.id;
    ownerByTask.set(task.id, owner);
    return owner;
  };
  for (const task of tasks) ownerOf(task);

  const taskRootsByProject = new Map<string, ScheduleTask[]>();
  const childrenByTask = new Map<string, ScheduleTask[]>();
  for (const task of tasks) {
    const owner = ownerByTask.get(task.id) ?? root.id;
    const parent = task.parentTaskId && tasksById.get(task.parentTaskId);
    if (parent && ownerByTask.get(parent.id) === owner) {
      const children = childrenByTask.get(parent.id) ?? [];
      children.push(task);
      childrenByTask.set(parent.id, children);
    } else {
      const roots = taskRootsByProject.get(owner) ?? [];
      roots.push(task);
      taskRootsByProject.set(owner, roots);
    }
  }

  const rows: ProjectScheduleRow[] = [];
  const seenProjects = new Set<string>();
  const seenTasks = new Set<string>();
  const walkTask = (task: ScheduleTask, depth: number) => {
    if (seenTasks.has(task.id)) return;
    seenTasks.add(task.id);
    const children = childrenByTask.get(task.id) ?? [];
    rows.push(taskScheduleRow(task, depth, children.length > 0));
    for (const child of children) walkTask(child, depth + 1);
  };
  const walkProject = (project: ProjectForSchedule, depth: number) => {
    if (seenProjects.has(project.id)) return;
    seenProjects.add(project.id);
    const children = childrenByProject.get(project.id) ?? [];
    const ownTasks = taskRootsByProject.get(project.id) ?? [];
    rows.push(
      projectScheduleRow(
        project,
        depth,
        children.length > 0 || ownTasks.length > 0,
      ),
    );
    for (const task of ownTasks) walkTask(task, depth + 1);
    for (const child of children) walkProject(child, depth + 1);
  };
  walkProject(root, 0);
  return rows;
}
