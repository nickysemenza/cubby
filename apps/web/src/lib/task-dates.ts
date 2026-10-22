import type { TaskOut } from "@cubby/schemas/project";

/** A task remains due through the inclusive end of its window. */
export function effectiveTaskDueDate(row: Pick<TaskOut, "due">): string | null {
  return row.due?.end ?? row.due?.start ?? null;
}
