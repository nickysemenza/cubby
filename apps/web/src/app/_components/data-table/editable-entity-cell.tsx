"use client";

import { Pencil, X } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";

import type { FieldSuggestionSource } from "~/app/_components/ai/field-suggestion";
import { FieldSuggestionApply } from "~/app/_components/ai/field-suggestion-apply";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import type { ComboboxItem, PickerEntity } from "../combobox/combobox-types";
import { EntityPicker } from "../combobox/entity-picker";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import type { CellClipboardSpec } from "./cell-clipboard";
import { CellEditTrigger } from "./cell-edit-trigger";
import { CellEditorOverlay } from "./cell-editor-overlay";
import {
  useCellEditState,
  useEditorCommit,
  useOptimisticDisplayValue,
} from "./editable-cell";

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
  label: PickerEntity;
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
  clipboard?: CellClipboardSpec<ComboboxItem<TId> | null>;
  /** When the field's `control.suggest` exists — queries only while the
   * editor is open (mirrors `EditableSelectEditor`'s `FieldSuggestionApply`),
   * never at rest. */
  suggest?: FieldSuggestionSource;
}

/**
 * Editable cell for a single related entity, backed by an async entity search.
 * Sibling of `EditableCell` (which only supports static option lists) — same
 * trigger / overlay / commit-on-pick / optimistic-display semantics, but the
 * editor is the shared Base UI `EntityPicker`, fed by a `With*Search` render-prop
 * provider.
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
  suggest,
}: EditableEntityCellProps<TId>) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(
    value,
    itemIdEquals,
  );
  const edit = useCellEditState(clipboard, setOptimisticValue);

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
        suggest={suggest}
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
          className="shrink-0 p-1 opacity-0 transition-opacity group-hover/pencil:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
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

/**
 * Commit-on-pick (matches `EditableCell`'s select/date editors): selecting an
 * item in the combobox — including toggling the current item off to clear when
 * `clearable` — saves + closes immediately, no separate ✓ confirm step.
 * Picking the SAME item, or clearing a non-clearable relation, closes without a
 * write; a save rejection toasts and keeps the editor open with the attempted
 * selection intact. The ✗ button stays as the explicit mouse cancel affordance
 * (Escape via the overlay also works). `EntityPicker` closes its
 * own dropdown on select, so the whole editor folds away in one gesture.
 */
function EditableEntityEditor<TId extends string>({
  value,
  onSave,
  SearchProvider,
  label,
  clearable,
  filterItems,
  suggest,
  onCancel,
  onCommit,
}: {
  value: ComboboxItem<TId> | null;
  onSave: (id: TId | null) => Promise<void>;
  SearchProvider: (props: WithEntitySearchProps<TId>) => React.ReactNode;
  label: PickerEntity;
  clearable?: boolean;
  filterItems?: (item: ComboboxItem<TId>) => boolean;
  suggest?: FieldSuggestionSource;
  onCancel: () => void;
  onCommit: (value: ComboboxItem<TId> | null) => void;
}) {
  const [selected, setSelected] = useState<ComboboxItem<TId> | null>(value);
  // EntityPicker closes its dropdown synchronously on click (before
  // the awaited save resolves), so a fast second pick would otherwise fire a
  // concurrent onSave whose last-to-resolve wins regardless of click order. The
  // pointer-events gate on the wrapper below is the visual affordance;
  // useEditorCommit's pendingRef is the hard guard (CSS pointer-events isn't
  // enforced by keyboard interaction or jsdom).
  const saveId = useCallback(
    (next: ComboboxItem<TId> | null) => onSave(next?.id ?? null),
    [onSave],
  );
  const { isPending, commit } = useEditorCommit<ComboboxItem<TId> | null>({
    onSave: saveId,
    onCommit,
    onCancel,
  });

  const handlePick = useCallback(
    (next: ComboboxItem<TId> | null) => {
      // Reflect the attempted selection in the combobox immediately (kept even
      // on the unchanged / rejected paths so the widget shows what was clicked).
      setSelected(next);
      // Unchanged, or cleared on a non-clearable relation → plain cancel.
      void commit(next, {
        unchanged: next?.id === value?.id || (next === null && !clearable),
      });
    },
    [value, clearable, commit],
  );

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="inline-flex w-full items-center gap-1">
        {/* Mid-save pick gate — mirrors EditableDateEditor's isPending wrapper. */}
        <div
          className={cn(
            "min-w-0 flex-1",
            isPending && "pointer-events-none opacity-50",
          )}
        >
          <SearchProvider>
            {({
              items,
              onSearchChange,
              isLoading,
              onCreateNew,
              onOpenChange,
            }) => (
              <EntityPicker
                entity={label}
                label={label}
                items={filterItems ? items.filter(filterItems) : items}
                onSearchChange={onSearchChange}
                isLoading={isLoading}
                value={selected}
                setValue={handlePick}
                onCreateNew={onCreateNew}
                onOpenChange={onOpenChange}
                // Open + focus the search input on mount. Focus-only: the entity
                // search input is internal state, so a type-to-edit seed char isn't
                // threaded here.
                openOnMount
                compact
                clearable={clearable}
              />
            )}
          </SearchProvider>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onCancel}
          disabled={isPending}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {suggest && (
        <FieldSuggestionApply
          source={suggest}
          currentValue={value?.id ?? null}
          onApply={(suggestion) => {
            if (!suggestion.value) return;
            // SAFETY: `suggest.targets` names one reference field of `TId`'s
            // entity; the suggestion's `value` is that field's id shape.
            handlePick({
              id: suggestion.value as TId,
              shortcode: suggestion.value,
              name: suggestion.label ?? suggestion.value,
            });
          }}
        />
      )}
    </div>
  );
}
