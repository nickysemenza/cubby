"use client";

import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type React from "react";
import { useCallback, useState } from "react";

import { Button } from "~/components/ui/button";

import type { CellClipboardSpec } from "../data-table/cell-clipboard";
import { CellEditTrigger } from "../data-table/cell-edit-trigger";
import { CellEditorOverlay } from "../data-table/cell-editor-overlay";
import {
  useCellEditState,
  useEditorCommit,
  useOptimisticDisplayValue,
} from "../data-table/editable-cell";
import { TagInput } from "./recipe-form/tag-input";

/**
 * Order-sensitive array equality for the optimistic display value. Must be a
 * module-level stable reference (see `useOptimisticDisplayValue`) — the default
 * reference equality would never release the optimistic array. Tags are a
 * normalized, order-preserving vocabulary, so a join compare is sufficient.
 */
const tagsEqual = (a: string[] | null, b: string[] | null): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return a.length === b.length && a.join("\0") === b.join("\0");
};

/** Normalize an edited tag list to the saved value: empty → null (clears). */
function toSaved(tags: string[]): string[] | null {
  return tags.length === 0 ? null : tags;
}

interface EditableTagsCellProps {
  value: string[] | null;
  onSave: (value: string[] | null) => Promise<void>;
  renderValue: (value: string[] | null) => React.ReactNode;
  /** Enable cmd-C / cmd-V on the focused display trigger. */
  clipboard?: CellClipboardSpec<string[] | null>;
}

/**
 * Sheets-style inline-editable tags cell — the recipe-tag analogue of
 * `EditableSelectCellInternal`. Enter / double-click opens a `TagInput` editor
 * over the cell (its chips input uses Enter to add a chip, so commit is the
 * Check button; Escape cancels via the overlay). Composed from the generic
 * data-table cell shell (`CellEditTrigger` + `CellEditorOverlay` +
 * `useCellEditState`); lives in the recipe layer because `TagInput` is
 * recipe-domain.
 */
export function EditableTagsCell({
  value,
  onSave,
  renderValue,
  clipboard,
}: EditableTagsCellProps) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(
    value,
    tagsEqual,
  );
  const edit = useCellEditState<string[] | null>(clipboard, setOptimisticValue);

  return (
    <>
      <CellEditTrigger
        ref={edit.triggerRef}
        onStartEdit={edit.open}
        clipboard={edit.clipboard}
      >
        {renderValue(displayValue)}
      </CellEditTrigger>
      {edit.isEditing && (
        <CellEditorOverlay
          anchorEl={edit.triggerRef.current}
          onRequestCancel={edit.cancel}
        >
          <EditableTagsEditor
            value={value}
            seedText={edit.seedText}
            onSave={onSave}
            onCancel={edit.cancel}
            onCommit={(nextValue) => {
              setOptimisticValue(nextValue);
              edit.cancel();
            }}
          />
        </CellEditorOverlay>
      )}
    </>
  );
}

function EditableTagsEditor({
  value,
  seedText,
  onSave,
  onCancel,
  onCommit,
}: {
  value: string[] | null;
  /** Type-to-edit: the char that opened the editor, seeded as a NEW tag in the
   * input (existing chips are kept — chips semantics, not scalar replace). */
  seedText: string | null;
  onSave: (value: string[] | null) => Promise<void>;
  onCancel: () => void;
  onCommit: (value: string[] | null) => void;
}) {
  const [editedTags, setEditedTags] = useState<string[]>(value ?? []);
  const { isPending, commit } = useEditorCommit<string[] | null>({
    onSave,
    onCommit,
    onCancel,
  });

  // Sync state from prop during render (React recommended pattern), mirroring
  // the select editor.
  const [prevValue, setPrevValue] = useState<string[] | null>(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setEditedTags(value ?? []);
  }

  const handleSave = useCallback(async () => {
    const next = toSaved(editedTags);
    await commit(next, { unchanged: tagsEqual(next, value) });
  }, [editedTags, value, commit]);

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions -- Inline table-editor controls own keyboard behavior; this wrapper only blocks the row click.
    <div
      className="inline-flex items-start gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <TagInput
        value={editedTags}
        onChange={setEditedTags}
        className="w-64"
        focusOnMount
        initialInputValue={seedText ?? undefined}
        // Enter with text chips it; Enter again (empty input) commits — so the
        // whole edit is type → Enter → Enter without reaching for the ✓.
        onEmptyEnter={isPending ? undefined : () => void handleSave()}
      />
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void handleSave()}
        disabled={isPending}
      >
        <CheckIcon className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={onCancel}
        disabled={isPending}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
