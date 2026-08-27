import type { TaskStatus } from "@cubby/schemas/project";
import { useState } from "react";
import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { taskStatusOptions } from "~/app/tasks/task-options";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";

interface SetTaskStatusItem {
  id: string;
  name: string;
}

interface SetTaskStatusDialogProps<T extends SetTaskStatusItem> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: T[];
  onConfirm: (status: TaskStatus) => Promise<void>;
  isPending: boolean;
  /**
   * The row's current status. Supplying it previews `current → next` and dims
   * the rows already in the chosen status — the reason this dialog is generic
   * over its row type rather than narrowing to `{ id, name }`.
   */
  currentStatus?: (item: T) => TaskStatus;
}

/**
 * Bulk "set status" dialog for the tasks list page — same shell as
 * {@link MoveToProjectDialog} (a `BulkActionDialog` + a single picker), swapping
 * the project combobox for the task status enum. Expenses have no status
 * field, so this stays task-only (unlike the shared move dialog).
 */
export function SetTaskStatusDialog<T extends SetTaskStatusItem>({
  open,
  onOpenChange,
  items,
  onConfirm,
  isPending,
  currentStatus,
}: SetTaskStatusDialogProps<T>) {
  const [status, setStatus] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) setStatus(null);
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (status === null) return;
    await onConfirm(status as TaskStatus);
    setStatus(null);
  };

  const count = items.length;
  const labelOf = (value: string) =>
    taskStatusOptions.find((option) => option.value === value)?.label ?? value;

  return (
    <BulkActionDialog
      open={open}
      onOpenChange={handleOpenChange}
      items={items}
      action="Set Status"
      actionLabel="Update"
      pendingLabel="Updating..."
      itemNoun="Task"
      description={`Set a new status for ${count} task${count !== 1 ? "s" : ""}.`}
      renderItem={(item) => item.name}
      // Nothing to project until the picker holds a value.
      effect={
        currentStatus && status !== null
          ? (item) => {
              const current = currentStatus(item);
              return {
                from: labelOf(current),
                to: labelOf(status),
                unchanged: current === status,
              };
            }
          : undefined
      }
      unchangedLabel="already in this status"
      onSubmit={handleSubmit}
      isPending={isPending}
    >
      <FormFieldGroup label="Status">
        <StaticPicker
          items={taskStatusOptions}
          value={status}
          onValueChange={setStatus}
          label="status"
          placeholder="Select a status…"
        />
      </FormFieldGroup>
    </BulkActionDialog>
  );
}
