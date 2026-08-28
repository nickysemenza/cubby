import { useState } from "react";

import { DatePickerInput } from "~/app/_components/date-picker-input";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { formatDateRange } from "~/app/projects/project-formatting";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Stack } from "~/components/layout";

interface SetDueDateItem {
  id: string;
  name: string;
}

interface SetDueDateDialogProps<T extends SetDueDateItem> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: T[];
  onConfirm: (
    dueDate: string | null,
    dueEndDate: string | null,
  ) => Promise<void>;
  isPending: boolean;
  /**
   * The row's current due window. Supplying it previews `current → next` and
   * dims the rows already in that window.
   */
  currentWindow?: (item: T) => {
    dueDate: string | null;
    dueEndDate: string | null;
  };
}

/**
 * Bulk "set due date" dialog — same shell as {@link SetTaskStatusDialog}/
 * {@link MoveToProjectDialog}, swapping the picker for a due-date range (start
 * required to submit, end optional — a single-date write clears `dueEndDate`,
 * matching the "single-date task = 1-day task" convention).
 */
export function SetDueDateDialog<T extends SetDueDateItem>({
  open,
  onOpenChange,
  items,
  onConfirm,
  isPending,
  currentWindow,
}: SetDueDateDialogProps<T>) {
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
      // Nothing to project until a start date is picked — that is also the
      // gate on submitting, so the two agree.
      effect={
        currentWindow && dueDate !== null
          ? (item) => {
              const current = currentWindow(item);
              return {
                from: formatDateRange(current.dueDate, current.dueEndDate),
                to: formatDateRange(dueDate, dueEndDate),
                unchanged:
                  current.dueDate === dueDate &&
                  current.dueEndDate === dueEndDate,
              };
            }
          : undefined
      }
      unchangedLabel="already in this window"
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
