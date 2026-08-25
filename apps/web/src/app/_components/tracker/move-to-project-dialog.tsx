import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithProjectSearch } from "~/app/_components/combobox/with-search-hook";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Button } from "~/components/ui/button";

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
  /** Runs the actual mutation — kept caller-owned so this dialog has no transport
   * shape coupling and works for both `task.bulkMove` and `expense.bulkMove`. */
  onConfirm: (projectId: ProjectShortcode | null) => Promise<void>;
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
  const [selected, setSelected] =
    useState<ComboboxItem<ProjectShortcode> | null>(null);
  const [clearRequested, setClearRequested] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelected(null);
      setClearRequested(false);
    }
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (selected === null && !clearRequested) return;
    await onConfirm(selected?.id ?? null);
    setSelected(null);
    setClearRequested(false);
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
        <WithProjectSearch>
          {({ items, onSearchChange, isLoading, onOpenChange }) => (
            <EntityPicker
              entity="project"
              label="project"
              items={items}
              value={selected}
              setValue={(item) => {
                setSelected(item);
                if (item) setClearRequested(false);
              }}
              onSearchChange={onSearchChange}
              isLoading={isLoading}
              onOpenChange={onOpenChange}
              placeholder="Select a project…"
            />
          )}
        </WithProjectSearch>
        {allowNoProject && (
          <Button
            type="button"
            variant={clearRequested ? "secondary" : "outline"}
            size="sm"
            className="mt-2"
            onClick={() => {
              setSelected(null);
              setClearRequested(true);
            }}
          >
            Clear project
          </Button>
        )}
      </FormFieldGroup>
    </BulkActionDialog>
  );
}
