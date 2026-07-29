import type { TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { addDays, endOfWeek, format, startOfWeek } from "date-fns";
import { match } from "ts-pattern";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";
import { getStatusChartColor } from "~/lib/status-colors";

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

/**
 * `{value,label,color}` options for the status filter/inline-edit select. Not
 * `buildSelectOptions` — that helper carries no color, and the swatch is what
 * ties the picklist to the status chip the cell renders.
 */
export const taskStatusOptions: FilterableComboboxItem[] = taskStatusValues.map(
  (value) => ({
    value,
    label: TASK_STATUS_LABELS[value],
    color: getStatusChartColor(value),
  }),
);

/** Fixed preset values for the task due-date filter. */
const dueRangeValues = ["overdue", "week", "30d"] as const;
type DueRangePreset = (typeof dueRangeValues)[number];

const dueRangeLabels: Record<DueRangePreset, string> = {
  overdue: "Overdue",
  week: "Due this week",
  "30d": "Due in 30 days",
};

/** `{value,label}` options for the task due-date filter select. */
export const dueRangeOptions = buildSelectOptions(
  dueRangeValues,
  dueRangeLabels,
);

/**
 * Resolves a due-date preset (as read off the "due" column filter) into
 * inclusive "YYYY-MM-DD" bounds on `dueFrom`/`dueTo`, anchored on today's local
 * date (task `dueDate` is timezone-free, so bounds are computed from local
 * `today`, never UTC). An unknown/undefined preset resolves to `{}`.
 */
export function resolveDueRange(preset: string | undefined): {
  dueFrom?: string;
  dueTo?: string;
} {
  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");
  return match(preset)
    .with("overdue", () => ({ dueTo: todayStr }))
    .with("week", () => ({
      dueFrom: format(startOfWeek(today), "yyyy-MM-dd"),
      dueTo: format(endOfWeek(today), "yyyy-MM-dd"),
    }))
    .with("30d", () => ({
      dueFrom: todayStr,
      dueTo: format(addDays(today, 30), "yyyy-MM-dd"),
    }))
    .otherwise(() => ({}));
}
