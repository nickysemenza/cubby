import type { TaskOut } from "@cubby/schemas/project";

/** A task remains due through the inclusive end of its window. */
export const taskDueDatePrecedence = ["end", "start"] as const;

export function effectiveTaskDueDate(row: Pick<TaskOut, "due">): string | null {
  return (
    taskDueDatePrecedence
      .map((key) => row.due?.[key])
      .find((date) => date != null) ?? null
  );
}
