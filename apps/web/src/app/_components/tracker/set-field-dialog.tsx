import { useState } from "react";
import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

interface SetFieldItem {
  id: string;
  name: string;
}

interface SetFieldDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: SetFieldItem[];
  onConfirm: (value: string) => Promise<void>;
  isPending: boolean;
  /** Enum options for the picker (e.g. tradeOptions, costTypeOptions). */
  options: FilterableComboboxItem[];
  /** Field label shown above the picker (e.g. "Trade", "Cost Type"). */
  fieldLabel: string;
  /** Entity noun for the dialog copy (e.g. "Task", "Expense"). */
  itemNoun: string;
}

/**
 * Generic bulk "set <field>" dialog — the same shell as
 * {@link SetTaskStatusDialog}/{@link MoveToProjectDialog}, parameterized by an
 * enum option set. Used for bulk trade (tasks + expenses) and bulk cost-type
 * (expenses). A required enum, so an empty selection is a no-op submit.
 */
export function SetFieldDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
  isPending,
  options,
  fieldLabel,
  itemNoun,
}: SetFieldDialogProps) {
  const [value, setValue] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) setValue(null);
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (value === null) return;
    await onConfirm(value);
    setValue(null);
  };

  const count = items.length;
  const lowerNoun = itemNoun.toLowerCase();

  return (
    <BulkActionDialog
      open={open}
      onOpenChange={handleOpenChange}
      items={items}
      action={`Set ${fieldLabel}`}
      actionLabel="Update"
      pendingLabel="Updating..."
      itemNoun={itemNoun}
      description={`Set a new ${fieldLabel.toLowerCase()} for ${count} ${lowerNoun}${count !== 1 ? "s" : ""}.`}
      renderItem={(item) => item.name}
      onSubmit={handleSubmit}
      isPending={isPending}
    >
      <FormFieldGroup label={fieldLabel}>
        <StaticPicker
          items={options}
          value={value}
          onValueChange={setValue}
          label={fieldLabel.toLowerCase()}
          placeholder={`Select a ${fieldLabel.toLowerCase()}…`}
        />
      </FormFieldGroup>
    </BulkActionDialog>
  );
}
