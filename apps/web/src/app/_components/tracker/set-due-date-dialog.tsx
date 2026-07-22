import { useState } from "react";
import { DatePickerInput } from "~/app/_components/date-picker-input";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Stack } from "~/components/layout";

interface SetDueDateItem {
  id: string;
  name: string;
}

interface SetDueDateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: SetDueDateItem[];
  onConfirm: (
    dueDate: string | null,
    dueEndDate: string | null,
  ) => Promise<void>;
  isPending: boolean;
}

/**
 * Bulk "set due date" dialog — same shell as {@link SetTaskStatusDialog}/
 * {@link MoveToProjectDialog}, swapping the picker for a due-date range (start
 * required to submit, end optional — a single-date write clears `dueEndDate`,
 * matching the "single-date task = 1-day task" convention).
 */
export function SetDueDateDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
  isPending,
}: SetDueDateDialogProps) {
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [dueEndDate, setDueEndDate] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setDueDate(null);
      setDueEndDate(null);
    }
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (dueDate === null) return;
    await onConfirm(dueDate, dueEndDate);
    setDueDate(null);
    setDueEndDate(null);
  };

  const count = items.length;

  return (
    <BulkActionDialog
      open={open}
      onOpenChange={handleOpenChange}
      items={items}
      action="Set Due Date"
      actionLabel="Update"
      pendingLabel="Updating..."
      itemNoun="Task"
      description={`Set a due date for ${count} task${count !== 1 ? "s" : ""}.`}
      renderItem={(item) => item.name}
      onSubmit={handleSubmit}
      isPending={isPending}
    >
      <Stack gap="sm">
        <FormFieldGroup label="Due date">
          <DatePickerInput
            value={dueDate}
            onChange={setDueDate}
            placeholder="Select due date…"
          />
        </FormFieldGroup>
        <FormFieldGroup label="End date (optional)">
          <DatePickerInput
            value={dueEndDate}
            onChange={setDueEndDate}
            placeholder="Select end date…"
            clearable
          />
        </FormFieldGroup>
      </Stack>
    </BulkActionDialog>
  );
}
