import type { CalendarItemKind } from "@cubby/schemas/calendar";
import { CreateExpenseDialog } from "~/app/expenses/create-expense-dialog";
import { CreateMealDialog } from "~/app/meals/create-meal-dialog";
import { CreateProjectDialog } from "~/app/projects/create-project-dialog";
import { CreateTaskDialog } from "~/app/tasks/create-task-dialog";

interface CalendarCreateDialogProps {
  kind: CalendarItemKind;
  date?: string;
  onOpenChange: (open: boolean) => void;
}

export function CalendarCreateDialog({
  kind,
  date,
  onOpenChange,
}: CalendarCreateDialogProps) {
  if (kind === "meal") {
    return (
      <CreateMealDialog open onOpenChange={onOpenChange} presetDate={date} />
    );
  }
  if (kind === "task") {
    return (
      <CreateTaskDialog open onOpenChange={onOpenChange} presetDate={date} />
    );
  }
  if (kind === "expense") {
    return (
      <CreateExpenseDialog
        open
        onOpenChange={onOpenChange}
        presetDate={date}
        presetFuture
      />
    );
  }
  return (
    <CreateProjectDialog open onOpenChange={onOpenChange} presetDate={date} />
  );
}
