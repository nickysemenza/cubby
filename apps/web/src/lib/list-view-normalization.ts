import { projectStatusSchema, taskStatusValues } from "@cubby/schemas/project";

const PROJECT_RENDERERS = ["overview", "analytics", "data", "gallery"] as const;
export type ProjectRenderer = (typeof PROJECT_RENDERERS)[number];

const TASK_RENDERERS = ["next", "board", "timeline", "list"] as const;
export type TaskRenderer = (typeof TASK_RENDERERS)[number];

/**
 * How the Data tab's Projects section draws its rows. A renderer, not a view:
 * both draw the same server-selected set — `tree` just swaps `project.list`
 * for `project.tree`, which pages by root of the filtered forest so the nesting
 * has an honest shape.
 */
export const PROJECT_ROWS_RENDERERS = ["flat", "tree"] as const;
export type ProjectRowsRenderer = (typeof PROJECT_ROWS_RENDERERS)[number];

export function normalizeProjectRenderer(view: string | undefined): {
  view: ProjectRenderer | undefined;
  statuses?: Array<(typeof projectStatusSchema.enum)["done"]>;
} {
  if (view === "history") {
    return { view: "data", statuses: [projectStatusSchema.enum.done] };
  }
  return {
    view: PROJECT_RENDERERS.includes(view as ProjectRenderer)
      ? (view as ProjectRenderer)
      : undefined,
  };
}

export function normalizeTaskRenderer(view: string | undefined): {
  view: TaskRenderer | undefined;
  status?: string;
  project?: string;
  parentTask?: string;
  clearFilters?: true;
} {
  if (view === "history") return { view: "list", status: "done" };
  if (view === "inbox") {
    return {
      view: "list",
      status: "not_started,later,in_progress,blocked",
      project: "__none__",
      parentTask: "__none__",
    };
  }
  if (view === "all") return { view: "list", clearFilters: true };
  return {
    view: TASK_RENDERERS.includes(view as TaskRenderer)
      ? (view as TaskRenderer)
      : undefined,
  };
}

export const isValidTaskStatusFilter = (value: string | undefined): boolean =>
  value === undefined ||
  value
    .split(",")
    .every((status) => taskStatusValues.includes(status as never));

export const isValidProjectDateFilter = (value: string | undefined): boolean =>
  value === undefined ||
  value === "3m" ||
  value === "12m" ||
  value === "ytd" ||
  /^\d{4}$/.test(value);
