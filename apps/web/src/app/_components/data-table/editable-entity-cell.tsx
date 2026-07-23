"use client";

import { Check, Pencil, X } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { getErrorMessage } from "~/lib/error-utils";
import { DialogCompatibleCombobox } from "../combobox/combobox-dialog";
import type { ComboboxItem } from "../combobox/combobox-types";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import type { CellClipboardSpec } from "./cell-clipboard";
import { CellEditTrigger } from "./cell-edit-trigger";
import { CellEditorOverlay } from "./cell-editor-overlay";
import { useCellEditState, useOptimisticDisplayValue } from "./editable-cell";

const itemIdEquals = <TId extends string>(
  a: ComboboxItem<TId> | null,
  b: ComboboxItem<TId> | null,
) => a?.id === b?.id;

export interface EditableEntityCellProps<TId extends string> {
  /** Current related entity as a combobox item (null = unset). */
  value: ComboboxItem<TId> | null;
  /** Save the new id (null only when `clearable`). */
  onSave: (id: TId | null) => Promise<void>;
  /** WithLocationSearch / WithIngredientSearch / ... — injected so unit tests can stub it. */
  SearchProvider: (props: WithEntitySearchProps<TId>) => React.ReactNode;
  /** Combobox placeholder noun, e.g. "location", "ingredient". */
  label: string;
  /** Allow saving null (clear the relation). Without it, an empty selection is a no-op cancel. */
  clearable?: boolean;
  /** Hide rows from the dropdown (e.g. a location can't be its own parent). */
  filterItems?: (item: ComboboxItem<TId>) => boolean;
  renderValue: (value: ComboboxItem<TId> | null) => React.ReactNode;
  /**
   * Display-mode shape. "wrap" (default): the whole rendered value is the
   * edit trigger. "pencil": the rendered value stays outside the trigger
   * (so links inside it remain navigable — interactive-inside-interactive is
   * invalid) and a small always-faint pencil button is the trigger and
   * clipboard target.
   */
  trigger?: "wrap" | "pencil";
  /** Enable cmd-C / cmd-V on the focused trigger. */
  clipboard?: CellClipboardSpec;
}

/**
 * Editable cell for a single related entity, backed by an async entity search.
 * Sibling of `EditableCell` (which only supports static option lists) — same
 * trigger / overlay / Check/X / optimistic-display semantics, but the editor
 * is a `DialogCompatibleCombobox` fed by a `With*Search` render-prop provider.
 */
export function EditableEntityCell<TId extends string>({
  value,
  onSave,
  SearchProvider,
  label,
  clearable,
  filterItems,
  renderValue,
  trigger = "wrap",
  clipboard,
}: EditableEntityCellProps<TId>) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(
    value,
    itemIdEquals,
  );
  const edit = useCellEditState(clipboard, (saved) =>
    setOptimisticValue(saved as ComboboxItem<TId> | null),
  );

  const editor = edit.isEditing && (
    <CellEditorOverlay
      anchorEl={edit.triggerRef.current}
      onRequestCancel={edit.cancel}
    >
      <EditableEntityEditor
        value={value}
        onSave={onSave}
        SearchProvider={SearchProvider}
        label={label}
        clearable={clearable}
        filterItems={filterItems}
        onCancel={edit.cancel}
        onCommit={(nextValue) => {
          setOptimisticValue(nextValue);
          edit.cancel();
        }}
      />
    </CellEditorOverlay>
  );

  if (trigger === "pencil") {
    return (
      <Row align="center" gap="xs" className="group/pencil min-w-0">
        <span className="min-w-0 truncate">{renderValue(displayValue)}</span>
        <CellEditTrigger
          ref={edit.triggerRef}
          onStartEdit={edit.open}
          clipboard={edit.clipboard}
          hidePencilIcon
          aria-label={`Edit ${label}`}
          className="shrink-0 p-1 opacity-40 pointer-coarse:opacity-100 transition-opacity focus-visible:opacity-100 group-hover/pencil:opacity-100"
        >
          <Pencil className="size-3 text-muted-foreground" />
        </CellEditTrigger>
        {editor}
      </Row>
    );
  }

  return (
    <>
      <CellEditTrigger
        ref={edit.triggerRef}
        onStartEdit={edit.open}
        clipboard={edit.clipboard}
      >
        {renderValue(displayValue)}
      </CellEditTrigger>
      {editor}
    </>
  );
}

function EditableEntityEditor<TId extends string>({
  value,
  onSave,
  SearchProvider,
  label,
  clearable,
  filterItems,
  onCancel,
  onCommit,
}: {
  value: ComboboxItem<TId> | null;
  onSave: (id: TId | null) => Promise<void>;
  SearchProvider: (props: WithEntitySearchProps<TId>) => React.ReactNode;
  label: string;
  clearable?: boolean;
  filterItems?: (item: ComboboxItem<TId>) => boolean;
  onCancel: () => void;
  onCommit: (value: ComboboxItem<TId> | null) => void;
}) {
  const [selected, setSelected] = useState<ComboboxItem<TId> | null>(value);
  const [isPending, setIsPending] = useState(false);

  const handleSave = useCallback(async () => {
    // Unchanged, or cleared on a non-clearable relation → plain cancel.
    if (selected?.id === value?.id || (selected === null && !clearable)) {
      onCancel();
      return;
    }

    setIsPending(true);
    try {
      await onSave(selected?.id ?? null);
      onCommit(selected);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsPending(false);
    }
  }, [selected, value, clearable, onSave, onCancel, onCommit]);

  return (
    <div className="inline-flex w-full items-center gap-1">
      <SearchProvider>
        {({ items, onSearchChange, isLoading, onCreateNew, onOpenChange }) => (
          <DialogCompatibleCombobox
            label={label}
            items={filterItems ? items.filter(filterItems) : items}
            onSearchChange={onSearchChange}
            isLoading={isLoading}
            value={selected}
            setValue={setSelected}
            onCreateNew={onCreateNew}
            onOpenChange={onOpenChange}
            // Open + focus the search input on mount. Focus-only: the entity
            // search input is internal state, so a type-to-edit seed char isn't
            // threaded here.
            autoFocus
          />
        )}
      </SearchProvider>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void handleSave()}
        disabled={isPending}
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={onCancel}
        disabled={isPending}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
