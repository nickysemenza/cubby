import type { TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { TASK_STATUS_LABELS } from "~/app/projects/shared";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

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
export const taskStatusOptions: FilterableComboboxItem[] = taskStatusValues.map(
  (value) => ({ value, label: TASK_STATUS_LABELS[value] }),
);
