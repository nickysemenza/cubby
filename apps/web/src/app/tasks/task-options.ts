import type { TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { buildSelectOptions } from "~/lib/select-options";

/**
 * Human-facing labels for the raw DB enum values — single source of truth for
 * task status display text everywhere (lists, badges, charts, command menu).
 * Lives here (not projects/shared.tsx) so shared.tsx can import the options/
 * variant maps below without a circular import; shared.tsx re-exports it for
 * its existing consumers.
 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "Not started",
  later: "Later",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

/** Badge tone per status — warm-paper ledger semantic tokens, not raw colors. */
export const taskStatusBadgeVariant: Record<
  TaskStatus,
  "secondary" | "outline" | "warning" | "destructive" | "positive"
> = {
  not_started: "secondary",
  later: "outline",
  in_progress: "warning",
  blocked: "destructive",
  done: "positive",
};

/** `{value,label}` options for the status filter/inline-edit select. */
export const taskStatusOptions = buildSelectOptions(
  taskStatusValues,
  TASK_STATUS_LABELS,
);
