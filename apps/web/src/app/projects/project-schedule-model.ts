import type {
  ProjectListItemOut,
  ProjectOut,
  TaskOut,
} from "@cubby/schemas/project";
import { addDays, format, parseISO } from "date-fns";

import { buildProjectTree } from "./project-tree";

export interface ProjectScheduleEntry {
  id: string;
  name: string;
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  meta: string;
  metaShort: string;
  segments: Array<{
    id: string;
    label: string;
    startDate: string;
    endDate?: string;
    variant: "range" | "milestone" | "reference";
    color?: string;
  }>;
  noDateLabel?: string;
  entity: "project" | "task";
  blockedByIds: string[];
  blockingIds: string[];
}

type ProjectForSchedule = Pick<
  ProjectOut,
  "id" | "name" | "status" | "dates" | "blockedByIds" | "blockingIds"
>;

function projectEntry(
  project: ProjectForSchedule,
  depth: number,
  expandable: boolean,
  expanded: boolean,
): ProjectScheduleEntry {
  const start = project.dates.effectiveStart;
  const end = project.dates.effectiveEnd;
  const dated = start ?? end;
  const source =
    project.dates.startSource === "derived" ||
    project.dates.endSource === "derived"
      ? " · Derived dates"
      : "";
  const segments: ProjectScheduleEntry["segments"] = [];
  if (dated) {
    const segment: ProjectScheduleEntry["segments"][number] = {
      id: `${project.id}:window`,
      label: project.name,
      startDate: dated,
      variant: start && end && end > start ? "range" : "milestone",
      color: "var(--domain-plan)",
    };
    if (start && end && end >= start) segment.endDate = end;
    segments.push(segment);
  }
  return {
    id: project.id,
    name: project.name,
    entity: "project",
    depth,
    expandable,
    expanded,
    meta: `Project · ${project.status.replaceAll("_", " ")}${source}`,
    metaShort: project.status.replaceAll("_", " "),
    segments,
    noDateLabel: dated ? undefined : "No dates",
    blockedByIds: project.blockedByIds,
    blockingIds: project.blockingIds,
  };
}

function taskEntry(
  task: TaskOut,
  depth: number,
  expandable: boolean,
  expanded: boolean,
): ProjectScheduleEntry {
  const start = task.dueDate;
  const end = task.dueEndDate;
  const dated = start ?? end;
  const segments: ProjectScheduleEntry["segments"] = [];
  if (dated) {
    const segment: ProjectScheduleEntry["segments"][number] = {
      id: `${task.id}:due`,
      label: start ? task.name : `${task.name} due end`,
      startDate: dated,
      variant: start && end && end > start ? "range" : "milestone",
      color: "var(--domain-plan)",
    };
    if (start && end && end >= start) segment.endDate = end;
    segments.push(segment);
  }
  return {
    id: task.id,
    name: task.name,
    entity: "task",
    depth,
    expandable,
    expanded,
    meta: `Task · ${task.status.replaceAll("_", " ")}${!start && end ? " · Due end only" : ""}`,
    metaShort: task.status.replaceAll("_", " "),
    segments,
    noDateLabel: dated ? undefined : "No due date",
    blockedByIds: task.blockedByIds,
    blockingIds: task.blockingIds,
  };
}

/** The server already selected and paged the filtered forest by root. */
export function buildPortfolioScheduleRows(
  projects: ProjectListItemOut[],
  collapsed: ReadonlySet<string>,
): ProjectScheduleEntry[] {
  const rows: ProjectScheduleEntry[] = [];
  const walk = (
    project: ReturnType<typeof buildProjectTree>[number],
    depth: number,
  ) => {
    const expandable = project.subRows.length > 0;
    const expanded = expandable && !collapsed.has(project.id);
    rows.push(projectEntry(project, depth, expandable, expanded));
    if (expanded) for (const child of project.subRows) walk(child, depth + 1);
  };
  for (const root of buildProjectTree(projects)) walk(root, 0);
  return rows;
}

/** All live descendants and their tasks, including rows without dates. */
export function buildDetailScheduleRows(
  root: ProjectOut,
  descendants: ProjectOut[],
  tasks: TaskOut[],
  collapsed: ReadonlySet<string>,
): ProjectScheduleEntry[] {
  const projects = [root, ...descendants.filter((item) => item.id !== root.id)];
  const projectIds = new Set(projects.map((item) => item.id));
  const childrenByProject = new Map<string, ProjectOut[]>();
  for (const item of projects) {
    if (!item.parentProjectId || !projectIds.has(item.parentProjectId))
      continue;
    const children = childrenByProject.get(item.parentProjectId) ?? [];
    children.push(item);
    childrenByProject.set(item.parentProjectId, children);
  }

  const tasksById = new Map(tasks.map((item) => [item.id, item]));
  const ownerByTask = new Map<string, string>();
  const ownerOf = (task: TaskOut, seen = new Set<string>()): string => {
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

  const taskRootsByProject = new Map<string, TaskOut[]>();
  const childrenByTask = new Map<string, TaskOut[]>();
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

  const rows: ProjectScheduleEntry[] = [];
  const seenProjects = new Set<string>();
  const seenTasks = new Set<string>();
  const walkTask = (task: TaskOut, depth: number) => {
    if (seenTasks.has(task.id)) return;
    seenTasks.add(task.id);
    const children = childrenByTask.get(task.id) ?? [];
    const expandable = children.length > 0;
    const expanded = expandable && !collapsed.has(task.id);
    rows.push(taskEntry(task, depth, expandable, expanded));
    if (expanded) for (const child of children) walkTask(child, depth + 1);
  };
  const walkProject = (project: ProjectOut, depth: number) => {
    if (seenProjects.has(project.id)) return;
    seenProjects.add(project.id);
    const children = childrenByProject.get(project.id) ?? [];
    const ownTasks = taskRootsByProject.get(project.id) ?? [];
    const expandable = children.length > 0 || ownTasks.length > 0;
    const expanded = expandable && !collapsed.has(project.id);
    rows.push(projectEntry(project, depth, expandable, expanded));
    if (!expanded) return;
    for (const task of ownTasks) walkTask(task, depth + 1);
    for (const child of children) walkProject(child, depth + 1);
  };
  walkProject(root, 0);
  return rows;
}

export function projectScheduleWindow(
  rows: readonly ProjectScheduleEntry[],
  today = new Date(),
) {
  const dates = rows.flatMap((row) =>
    row.segments.flatMap((segment) => [
      segment.startDate,
      segment.endDate ?? segment.startDate,
    ]),
  );
  const first = dates.length
    ? dates.reduce((a, b) => (a < b ? a : b))
    : format(today, "yyyy-MM-dd");
  const last = dates.length
    ? dates.reduce((a, b) => (a > b ? a : b))
    : format(today, "yyyy-MM-dd");
  return {
    startDate: format(addDays(parseISO(first), -14), "yyyy-MM-dd"),
    endDate: format(addDays(parseISO(last), 45), "yyyy-MM-dd"),
  };
}
