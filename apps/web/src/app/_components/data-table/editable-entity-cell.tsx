"use client";

import { Check, Pencil, X } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { getErrorMessage } from "~/lib/error-utils";
import { DialogCompatibleCombobox } from "../combobox/combobox-dialog";
import type { ComboboxItem } from "../combobox/combobox-types";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import { useOptimisticDisplayValue } from "./editable-cell";

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
}

/**
 * Editable cell for a single related entity, backed by an async entity search.
 * Sibling of `EditableCell` (which only supports static option lists) — same
 * pencil / Check / X / optimistic-display semantics, but the editor is a
 * `DialogCompatibleCombobox` fed by a `With*Search` render-prop provider.
 */
export function EditableEntityCell<TId extends string>({
  value,
  onSave,
  SearchProvider,
  label,
  clearable,
  filterItems,
  renderValue,
}: EditableEntityCellProps<TId>) {
  const [isEditing, setIsEditing] = useState(false);
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(
    value,
    itemIdEquals,
  );

  if (isEditing) {
    return (
      <EditableEntityEditor
        value={value}
        onSave={onSave}
        SearchProvider={SearchProvider}
        label={label}
        clearable={clearable}
        filterItems={filterItems}
        onCancel={() => setIsEditing(false)}
        onCommit={(nextValue) => {
          setOptimisticValue(nextValue);
          setIsEditing(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="group inline-flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted"
      onClick={(e) => {
        e.stopPropagation();
        setIsEditing(true);
      }}
    >
      {renderValue(displayValue)}
      <Pencil className="ml-1 h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
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
    // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation for row click; Escape cancels edit mode
    <div
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The combobox stops propagation of its own keys (and closes its
        // dropdown on Escape itself), so this only fires with focus on the
        // Check/X buttons — matching the other editors' Escape-to-cancel.
        if (e.key === "Escape") onCancel();
      }}
    >
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
          />
        )}
      </SearchProvider>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void handleSave()}
        disabled={isPending}
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={onCancel}
        disabled={isPending}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
