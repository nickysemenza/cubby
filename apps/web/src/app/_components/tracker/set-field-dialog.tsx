import { useState } from "react";

import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

interface SetFieldItem {
  id: string;
  name: string;
}

interface SetFieldDialogProps<T extends SetFieldItem> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: T[];
  onConfirm: (value: string) => Promise<void>;
  isPending: boolean;
  /** Enum options for the picker (e.g. tradeOptions, costTypeOptions). */
  options: FilterableComboboxItem[];
  /** Field label shown above the picker (e.g. "Trade", "Cost Type"). */
  fieldLabel: string;
  /** Entity noun for the dialog copy (e.g. "Task", "Expense"). */
  itemNoun: string;
  /**
   * The row's current value, as one of `options`' values. Supplying it is what
   * turns the row list into a `current → next` preview and dims the rows the
   * write would not change — the reason this dialog is generic over its row
   * type rather than narrowing to `{ id, name }`.
   */
  currentValue?: (item: T) => string | null;
}

/**
 * Generic bulk "set <field>" dialog — the same shell as
 * {@link SetTaskStatusDialog}/{@link MoveToProjectDialog}, parameterized by an
 * enum option set. Used for bulk trade (tasks + expenses) and bulk cost-type
 * (expenses). A required enum, so an empty selection is a no-op submit.
 */
export function SetFieldDialog<T extends SetFieldItem>({
  open,
  onOpenChange,
  items,
  onConfirm,
  isPending,
  options,
  fieldLabel,
  itemNoun,
  currentValue,
}: SetFieldDialogProps<T>) {
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
  const labelOf = (optionValue: string | null) =>
    options.find((option) => option.value === optionValue)?.label ??
    optionValue ??
    "None";

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
      // Nothing to project until the picker holds a value: before that the
      // "next" half of `current → next` would be empty for every row.
      effect={
        currentValue && value !== null
          ? (item) => {
              const current = currentValue(item);
              return {
                from: labelOf(current),
                to: labelOf(value),
                unchanged: current === value,
              };
            }
          : undefined
      }
      unchangedLabel="already set to this"
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
