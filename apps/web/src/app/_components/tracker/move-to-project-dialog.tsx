import { type ProjectId, unsafeProjectId } from "@cubby/schemas/identifiers";
import { useMemo, useState } from "react";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { FilterableCombobox } from "~/components/ui/combobox";

const NO_PROJECT_VALUE = "__none__";

interface MoveToProjectItem {
  id: string;
  name: string;
}

interface MoveToProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: MoveToProjectItem[];
  /** Noun for the dialog title/count line, e.g. "Task" / "Expense". */
  entityLabel: string;
  /** Include an explicit "No project" option. Defaults to true — both
   * task and expense `projectId` are nullable. */
  allowNoProject?: boolean;
  /** Runs the actual mutation — kept caller-owned so this dialog has no tRPC
   * shape coupling and works for both `task.bulkMove` and `expense.bulkMove`. */
  onConfirm: (projectId: ProjectId | null) => Promise<void>;
  isPending: boolean;
}

/**
 * Bulk "move to project" dialog shared by the tasks and expenses list pages.
 * Mirrors inventory's `MoveInventoryDialog` shape (a `BulkActionDialog` shell
 * + a single destination picker) minus the location-specific quantity
 * merging — a task/expense move is a plain `projectId` column write, so
 * there's no partial-quantity/source-location bookkeeping to do here.
 */
export function MoveToProjectDialog({
  open,
  onOpenChange,
  items,
  entityLabel,
  allowNoProject = true,
  onConfirm,
  isPending,
}: MoveToProjectDialogProps) {
  const { options: projectOptions } = useProjectOptions();
  const [selected, setSelected] = useState<string | null>(null);

  const comboboxItems = useMemo(
    () =>
      allowNoProject
        ? [{ value: NO_PROJECT_VALUE, label: "No project" }, ...projectOptions]
        : projectOptions,
    [projectOptions, allowNoProject],
  );

  const handleOpenChange = (next: boolean) => {
    if (!next) setSelected(null);
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (selected === null) return;
    await onConfirm(
      selected === NO_PROJECT_VALUE ? null : unsafeProjectId(selected),
    );
    setSelected(null);
  };

  const count = items.length;
  const noun = `${entityLabel.toLowerCase()}${count !== 1 ? "s" : ""}`;

  return (
    <BulkActionDialog
      open={open}
      onOpenChange={handleOpenChange}
      items={items}
      action="Move"
      pendingLabel="Moving..."
      itemNoun={entityLabel}
      description={`Move ${count} ${noun} to a different project${allowNoProject ? ", or clear the project entirely" : ""}.`}
      renderItem={(item) => item.name}
      onSubmit={handleSubmit}
      isPending={isPending}
    >
      <FormFieldGroup label="Project">
        <FilterableCombobox
          items={comboboxItems}
          value={selected}
          onValueChange={setSelected}
          placeholder="Select a project…"
        />
      </FormFieldGroup>
    </BulkActionDialog>
  );
}
