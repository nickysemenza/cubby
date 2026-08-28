import { projectStatusSchema, taskStatusSchema } from "@cubby/schemas/project";
import { z } from "zod";

const PROJECT_RENDERERS = ["overview", "analytics", "data", "gallery"] as const;
type ProjectRenderer = (typeof PROJECT_RENDERERS)[number];
const projectRendererSchema = z.enum(PROJECT_RENDERERS);

const TASK_RENDERERS = ["next", "board", "timeline", "list"] as const;
export type TaskRenderer = (typeof TASK_RENDERERS)[number];
const taskRendererSchema = z.enum(TASK_RENDERERS);

/**
 * How the Data tab's Projects section draws its rows. A renderer, not a view:
 * both draw the same server-selected set — `tree` just swaps `project.list`
 * for `project.tree`, which pages by root of the filtered forest so the nesting
 * has an honest shape.
 */
export const PROJECT_ROWS_RENDERERS = ["flat", "tree"] as const;
export type ProjectRowsRenderer = (typeof PROJECT_ROWS_RENDERERS)[number];

interface NormalizedProjectRenderer {
  view: ProjectRenderer | undefined;
  statuses?: Array<(typeof projectStatusSchema.enum)["done"]>;
}

export function normalizeProjectRenderer(
  view: string | undefined,
): NormalizedProjectRenderer {
  if (view === "history") {
    return { view: "data", statuses: [projectStatusSchema.enum.done] };
  }
  const parsed = projectRendererSchema.safeParse(view);
  return { view: parsed.success ? parsed.data : undefined };
}

interface NormalizedTaskRenderer {
  view: TaskRenderer | undefined;
  status?: string;
  project?: string;
  parentTask?: string;
  clearFilters?: true;
}

export function normalizeTaskRenderer(
  view: string | undefined,
): NormalizedTaskRenderer {
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
  const parsed = taskRendererSchema.safeParse(view);
  return { view: parsed.success ? parsed.data : undefined };
}

export const isValidTaskStatusFilter = (value: string | undefined): boolean =>
  value === undefined ||
  value
    .split(",")
    .every((status) => taskStatusSchema.safeParse(status).success);

export const isValidProjectDateFilter = (value: string | undefined): boolean =>
  value === undefined ||
  value === "3m" ||
  value === "12m" ||
  value === "ytd" ||
  /^\d{4}$/.test(value);
