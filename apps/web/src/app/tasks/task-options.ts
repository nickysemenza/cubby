import type { TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { TASK_STATUS_LABELS } from "@cubby/schemas/task-fields";
import { addDays, endOfWeek, format, startOfWeek } from "date-fns";
import { match } from "ts-pattern";

import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { getStatusChartColor } from "~/lib/status-colors";

/**
 * Human-facing labels for the raw DB enum values — single source of truth for
 * task status display text everywhere (lists, badges, charts, command menu).
 * Lives here (not projects/shared.tsx) so shared.tsx can import the options/
 * variant maps below without a circular import; shared.tsx re-exports it for
 * its existing consumers.
 */
export { TASK_STATUS_LABELS } from "@cubby/schemas/task-fields";

/** Badge tone per status — Porcelain semantic tokens, not raw colors. */
export const taskStatusBadgeVariant = {
  not_started: "secondary",
  later: "outline",
  in_progress: "warning",
  blocked: "destructive",
  done: "positive",
} satisfies Record<
  TaskStatus,
  "secondary" | "outline" | "warning" | "destructive" | "positive"
>;

/**
 * `{value,label,color}` options for the status filter/inline-edit select. Not
 * `buildSelectOptions` — that helper carries no color, and the colour is what
 * tints the table cell pill (see `renderOptionCell`), so this roster is the
 * single source of both the wording and the tone.
 */
export const taskStatusOptions: FilterableComboboxItem[] = taskStatusValues.map(
  (value) => ({
    value,
    label: TASK_STATUS_LABELS[value],
    color: getStatusChartColor(value),
  }),
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
