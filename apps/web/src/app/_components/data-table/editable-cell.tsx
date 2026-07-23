"use client";

import type { Amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { Check, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  FilterableCombobox,
  type FilterableComboboxItem,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { DatePickerInput } from "../date-picker-input";
import {
  showAmountAndPrice,
  tryFormatAmount,
} from "../inventory/format-amount";
import type { CellClipboardSpec } from "./cell-clipboard";
import { CellEditTrigger } from "./cell-edit-trigger";
import { CellEditorOverlay } from "./cell-editor-overlay";

/** Re-export for convenience */
export type { FilterableComboboxItem };

type EditableInputConfig = {
  type: "text" | "number";
  prefix?: string;
  step?: string;
  placeholder?: string;
  /**
   * Text-only: render a multi-line <Textarea> editor instead of a single-line
   * <Input>. Commits on blur / Cmd+Enter, cancels on Escape (plain Enter
   * inserts a newline). No-op for `type: "number"`.
   */
  multiline?: boolean;
  /** Rows for the multiline textarea (default 4). */
  rows?: number;
};

type EditableCurrencyConfig = {
  type: "currency";
};

type EditableSelectConfig = {
  type: "select";
  options: FilterableComboboxItem[];
  placeholder?: string;
};

type EditableDateConfig = {
  type: "date";
  placeholder?: string;
};

type EditableConfig =
  | EditableInputConfig
  | EditableCurrencyConfig
  | EditableSelectConfig
  | EditableDateConfig;

interface UseEditableCellOptions<T> {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  /** Parse input string to value. For select type, not needed. */
  parse?: (input: string) => T | null;
  /** Format value for input display. Defaults to String(value). */
  format?: (value: T) => string;
}

/**
 * Hook for managing editable cell state with optimistic updates.
 * After save succeeds, shows the new value immediately while react-query refetches.
 */
export function useEditableCell<T>({
  value,
  onSave,
  parse,
  format,
}: UseEditableCellOptions<T>) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [isPending, setIsPending] = useState(false);
  // undefined = no optimistic value, use prop; T | null = optimistic value to display
  const [optimisticValue, setOptimisticValue] = useState<T | null | undefined>(
    undefined,
  );

  // Display value: optimistic takes precedence when set
  const displayValue = optimisticValue !== undefined ? optimisticValue : value;

  const startEditing = useCallback(() => {
    const v = optimisticValue !== undefined ? optimisticValue : value;
    if (format && v !== null) {
      setInputValue(format(v));
    } else {
      setInputValue(v !== null ? String(v) : "");
    }
    setIsEditing(true);
  }, [value, optimisticValue, format]);

  const cancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const save = useCallback(async () => {
    const trimmed = inputValue.trim();
    const parsed = trimmed === "" ? null : parse ? parse(trimmed) : null;

    // Skip if value hasn't changed
    if (parsed === value || (parsed === null && value === null)) {
      setIsEditing(false);
      return;
    }

    setIsPending(true);
    try {
      await onSave(parsed);
      setOptimisticValue(parsed); // Show immediately
      setIsEditing(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsPending(false);
    }
  }, [inputValue, parse, value, onSave]);

  // Clear optimistic value when real value catches up
  useEffect(() => {
    if (optimisticValue !== undefined && value === optimisticValue) {
      setOptimisticValue(undefined);
    }
  }, [value, optimisticValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        cancel();
      }
    },
    [save, cancel],
  );

  return {
    isEditing,
    inputValue,
    setInputValue,
    displayValue,
    isPending,
    startEditing,
    cancel,
    save,
    handleKeyDown,
    setOptimisticValue,
  };
}

interface EditableCellProps<T> {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  config: EditableConfig;
  renderValue: (value: T | null) => React.ReactNode;
  /** Enable cmd-C / cmd-V on the focused display trigger. */
  clipboard?: CellClipboardSpec;
}

/**
 * Unified editable cell component.
 * Use config to specify the input type:
 * - { type: "text" } or { type: "number", step, prefix }
 * - { type: "currency" }
 * - { type: "select", options }
 */
export function EditableCell<T>({
  value,
  onSave,
  config,
  renderValue,
  clipboard,
}: EditableCellProps<T>) {
  // Select type has its own specialized implementation
  if (config.type === "select") {
    return (
      <EditableSelectCellInternal
        value={value as string | null}
        onSave={onSave as (value: string | null) => Promise<void>}
        options={config.options}
        placeholder={config.placeholder}
        renderValue={renderValue as (value: string | null) => React.ReactNode}
        clipboard={clipboard}
      />
    );
  }

  // Date type has its own specialized implementation
  if (config.type === "date") {
    return (
      <EditableDateCellInternal
        value={value as string | null}
        onSave={onSave as (value: string | null) => Promise<void>}
        placeholder={config.placeholder}
        renderValue={renderValue as (value: string | null) => React.ReactNode}
        clipboard={clipboard}
      />
    );
  }

  // Text/number/currency use the text input
  return (
    <EditableInputCellInternal
      value={value}
      onSave={onSave}
      config={config}
      renderValue={renderValue}
      clipboard={clipboard}
    />
  );
}

/**
 * Shared display/edit shell: the CellEditTrigger stays mounted in the cell as
 * the overlay's anchor (and clipboard/focus target); the editor renders over
 * it. Wires the clipboard spec's isEditing guard automatically, and routes a
 * successful paste's resolved value into `onPasted` so the hosting cell can
 * show it optimistically (same as a Check-button save).
 */
export function useCellEditState(
  clipboard: CellClipboardSpec | undefined,
  onPasted?: (value: unknown) => void,
) {
  const [isEditing, setIsEditing] = useState(false);
  // Type-to-edit seed (a printable char that opened the editor), captured at
  // open and cleared on cancel/commit. Held here — the ONE place — so every
  // editor reads it the same way instead of re-plumbing the CustomEvent.
  const [seedText, setSeedText] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const isEditingRef = useRef(false);
  isEditingRef.current = isEditing;

  // Open the editor. Doubles as the `CellEditTrigger.onStartEdit` handler:
  // click/double-click pass no arg (no seed), CELL_EDIT_EVENT threads the seed.
  const open = useCallback((seed?: string) => {
    setSeedText(seed ?? null);
    setIsEditing(true);
  }, []);

  const cancel = useCallback(() => {
    setIsEditing(false);
    setSeedText(null);
    triggerRef.current?.focus();
  }, []);

  const pasteThrough = clipboard?.onPasteValue;
  const clipboardWithGuard = clipboard
    ? {
        ...clipboard,
        isEditing: () => isEditingRef.current,
        onPasteValue: pasteThrough
          ? async (payload: { json?: unknown; text?: string }) => {
              const saved = await pasteThrough(payload);
              if (saved !== undefined) onPasted?.(saved);
              return saved;
            }
          : undefined,
      }
    : undefined;

  return {
    isEditing,
    seedText,
    open,
    triggerRef,
    cancel,
    clipboard: clipboardWithGuard,
  };
}

const referenceEquals = <T,>(a: T | null, b: T | null) => a === b;

/**
 * Optimistic display value for editable cells: after a successful save the new
 * value shows immediately, then hands back to the prop once react-query's
 * refetch catches up. `isEqual` must be referentially stable (module-level) —
 * pass one for object values (e.g. compare by id), where the default
 * reference equality would never release the optimistic value.
 */
export function useOptimisticDisplayValue<T>(
  value: T | null,
  isEqual: (a: T | null, b: T | null) => boolean = referenceEquals,
) {
  const [optimisticValue, setOptimisticValue] = useState<T | null | undefined>(
    undefined,
  );

  useEffect(() => {
    if (optimisticValue !== undefined && isEqual(value, optimisticValue)) {
      setOptimisticValue(undefined);
    }
  }, [value, optimisticValue, isEqual]);

  return {
    displayValue: optimisticValue !== undefined ? optimisticValue : value,
    setOptimisticValue,
  };
}

function EditableInputCellInternal<T>({
  value,
  onSave,
  config,
  renderValue,
  clipboard,
}: {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  config: EditableInputConfig | EditableCurrencyConfig;
  renderValue: (value: T | null) => React.ReactNode;
  clipboard?: CellClipboardSpec;
}) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(value);
  const edit = useCellEditState(clipboard, (saved) =>
    setOptimisticValue(saved as T | null),
  );

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
          <EditableInputEditor
            value={value}
            onSave={onSave}
            config={config}
            seedText={edit.seedText}
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

function EditableInputEditor<T>({
  value,
  onSave,
  config,
  seedText,
  onCancel,
  onCommit,
}: {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  config: EditableInputConfig | EditableCurrencyConfig;
  /** Type-to-edit: the character that opened the editor, seeded as the initial
   * input value (replacing the current value). `null` = normal open. */
  seedText: string | null;
  onCancel: () => void;
  onCommit: (value: T | null) => void;
}) {
  const isCurrency = config.type === "currency";
  const inputType = isCurrency ? "number" : config.type;
  const prefix = isCurrency
    ? "$"
    : "prefix" in config
      ? config.prefix
      : undefined;
  const step = isCurrency ? "0.01" : "step" in config ? config.step : undefined;
  const placeholder = isCurrency
    ? "0.00"
    : "placeholder" in config
      ? config.placeholder
      : undefined;
  const multiline =
    !isCurrency && "multiline" in config ? config.multiline : false;
  const rows = !isCurrency && "rows" in config ? config.rows : undefined;

  const parse = useCallback(
    (s: string): T | null => {
      if (inputType === "number" || isCurrency) {
        const num = parseFloat(s);
        return Number.isNaN(num) ? null : (num as T);
      }
      return s as unknown as T;
    },
    [inputType, isCurrency],
  );

  const format = useCallback((v: T): string => {
    return String(v);
  }, []);

  // Seeded (type-to-edit): the initial value IS the seed char (replaces the
  // current value); autoFocus leaves the caret at the end of the single char.
  const [inputValue, setInputValue] = useState(() =>
    seedText != null ? seedText : value !== null ? format(value) : "",
  );
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    // A seeded editor is initialized once at mount and must not be clobbered by
    // this value-sync effect; only a normal open tracks the incoming value.
    if (seedText != null) return;
    if (format && value !== null) {
      setInputValue(format(value));
    } else {
      setInputValue(value !== null ? String(value) : "");
    }
  }, [value, format, seedText]);

  const handleSave = useCallback(async () => {
    const trimmed = inputValue.trim();
    const parsed =
      trimmed === ""
        ? null
        : parse
          ? parse(trimmed)
          : (trimmed as unknown as T);

    // Skip if value hasn't changed
    if (parsed === value || (parsed === null && value === null)) {
      onCancel();
      return;
    }

    setIsPending(true);
    try {
      await onSave(parsed);
      onCommit(parsed);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsPending(false);
    }
  }, [inputValue, parse, value, onSave, onCancel, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        // Multiline: plain Enter inserts a newline; Cmd/Ctrl+Enter commits.
        if (multiline && !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        void handleSave();
      } else if (e.key === "Escape") {
        onCancel();
      }
    },
    [handleSave, onCancel, multiline],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation for row click
    <div
      className={cn(
        "inline-flex gap-1",
        multiline ? "items-start" : "items-center",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {prefix && (
        <span className="text-muted-foreground text-sm">{prefix}</span>
      )}
      {multiline ? (
        <Textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => void handleSave()}
          className="w-64"
          rows={rows ?? 4}
          placeholder={placeholder}
          autoFocus
          disabled={isPending}
        />
      ) : (
        <Input
          type={inputType}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-7 w-32"
          step={step}
          placeholder={placeholder}
          autoFocus
          disabled={isPending}
        />
      )}
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

function EditableSelectCellInternal({
  value,
  onSave,
  options,
  placeholder = "Select...",
  renderValue,
  clipboard,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  options: FilterableComboboxItem[];
  placeholder?: string;
  renderValue: (value: string | null) => React.ReactNode;
  clipboard?: CellClipboardSpec;
}) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(value);
  const edit = useCellEditState(clipboard, (saved) =>
    setOptimisticValue(saved as string | null),
  );

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
          <EditableSelectEditor
            value={value}
            onSave={onSave}
            options={options}
            placeholder={placeholder}
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

/**
 * Commit-on-pick (matches the date editor): choosing an option saves + closes
 * immediately — no separate ✓ confirm step. Picking the SAME value closes
 * without a write (handleSave's old unchanged path); a save rejection toasts
 * and keeps the editor open with the current value intact. The ✗ button stays
 * as the explicit mouse cancel affordance (Escape via the overlay also works).
 */
function EditableSelectEditor({
  value,
  onSave,
  options,
  placeholder,
  onCancel,
  onCommit,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  options: FilterableComboboxItem[];
  placeholder: string;
  onCancel: () => void;
  onCommit: (value: string | null) => void;
}) {
  const [isPending, setIsPending] = useState(false);

  const handlePick = useCallback(
    async (next: string | null) => {
      // Unchanged → close without a write.
      if (next === value) {
        onCancel();
        return;
      }

      setIsPending(true);
      try {
        await onSave(next);
        onCommit(next);
      } catch (err) {
        // Stay open with state intact so the user can retry or cancel.
        toast.error(getErrorMessage(err));
      } finally {
        setIsPending(false);
      }
    },
    [value, onSave, onCancel, onCommit],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation for row click
    <div
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <FilterableCombobox
        items={options}
        value={value}
        onValueChange={(next) => void handlePick(next)}
        placeholder={placeholder}
        disabled={isPending}
        className="w-48"
        // Focus-only seeding: the combobox filters its own internal input, so a
        // type-to-edit seed char isn't threaded here (documented focus-only).
        autoFocus
      />
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

function EditableDateCellInternal({
  value,
  onSave,
  placeholder,
  renderValue,
  clipboard,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
  renderValue: (value: string | null) => React.ReactNode;
  clipboard?: CellClipboardSpec;
}) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(value);
  const edit = useCellEditState(clipboard, (saved) =>
    setOptimisticValue(saved as string | null),
  );

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
          <EditableDateEditor
            value={value}
            onSave={onSave}
            placeholder={placeholder}
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

/**
 * Unlike the text/select editors, picking a day commits immediately — there's
 * no separate Check/X confirm step. `DatePickerInput`'s own popover owns
 * open/close; this just wires its `onChange` straight to `onSave`.
 */
function EditableDateEditor({
  value,
  onSave,
  placeholder,
  onCancel,
  onCommit,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
  onCancel: () => void;
  onCommit: (value: string | null) => void;
}) {
  const [isPending, setIsPending] = useState(false);

  const handleChange = useCallback(
    async (next: string | null) => {
      if (next === value) {
        onCancel();
        return;
      }

      setIsPending(true);
      try {
        await onSave(next);
        onCommit(next);
      } catch (err) {
        toast.error(getErrorMessage(err));
        onCancel();
      } finally {
        setIsPending(false);
      }
    },
    [value, onSave, onCancel, onCommit],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation for row click
    <div
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <DatePickerInput
        value={value}
        onChange={(next) => void handleChange(next)}
        placeholder={placeholder}
        clearable
        autoFocus
        className={cn("w-40", isPending && "pointer-events-none opacity-50")}
      />
    </div>
  );
}

interface EditableAmountCellProps {
  amount: Amount;
  /**
   * Omit entirely for an amount-only display (no price line). An ARRAY (even
   * empty) opts into the price display — showAmountAndPrice treats undefined
   * as "mappings still loading", so hosts that load mappings async must pass
   * `?? []`.
   */
  unitMappings?: UnitMapping[];
  onSave: (newAmount: Amount) => Promise<void>;
  /**
   * Wrap the display-mode content (e.g. in a detail-page link, mirroring
   * createNameColumn's editable renderValue). Edit mode is unaffected.
   */
  renderDisplay?: (content: React.ReactNode) => React.ReactNode;
  /** Enable cmd-C / cmd-V on the focused display trigger. */
  clipboard?: CellClipboardSpec;
}

/**
 * Editable cell for inventory amounts (value + unit).
 * Shows formatted amount (with price when unitMappings is provided) in
 * display mode. Shows two inputs (value, unit) in edit mode.
 */
export function EditableAmountCell({
  amount,
  unitMappings,
  onSave,
  renderDisplay,
  clipboard,
}: EditableAmountCellProps) {
  const [editingValue, setEditingValue] = useState(amount.value);
  const [editingUnit, setEditingUnit] = useState(amount.unit);
  const [isPending, setIsPending] = useState(false);
  const [optimisticAmount, setOptimisticAmount] = useState<Amount | undefined>(
    undefined,
  );
  const edit = useCellEditState(clipboard, (saved) =>
    setOptimisticAmount(saved as Amount),
  );

  const displayAmount = optimisticAmount ?? amount;

  // biome-ignore lint/correctness/useExhaustiveDependencies: edit.open is a stable callback
  const startEditing = useCallback(() => {
    const current = optimisticAmount ?? amount;
    setEditingValue(current.value);
    setEditingUnit(current.unit);
    // Amount is a compound (value + unit) editor; a type-to-edit seed isn't
    // meaningful here, so open without one (the value input still autofocuses).
    edit.open();
  }, [amount, optimisticAmount]);

  const save = useCallback(async () => {
    const newAmount = { value: editingValue, unit: editingUnit.trim() };

    // Skip if unchanged
    if (newAmount.value === amount.value && newAmount.unit === amount.unit) {
      edit.cancel();
      return;
    }

    setIsPending(true);
    try {
      await onSave(newAmount);
      setOptimisticAmount(newAmount);
      edit.cancel();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsPending(false);
    }
  }, [editingValue, editingUnit, amount, onSave, edit.cancel]);

  // Clear optimistic value when real value catches up
  useEffect(() => {
    if (
      optimisticAmount &&
      amount.value === optimisticAmount.value &&
      amount.unit === optimisticAmount.unit
    ) {
      setOptimisticAmount(undefined);
    }
  }, [amount, optimisticAmount]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        edit.cancel();
      }
    },
    [save, edit.cancel],
  );

  return (
    <>
      <CellEditTrigger
        ref={edit.triggerRef}
        onStartEdit={startEditing}
        clipboard={edit.clipboard}
      >
        {(renderDisplay ?? ((content: React.ReactNode) => content))(
          unitMappings === undefined
            ? tryFormatAmount(displayAmount)
            : showAmountAndPrice(displayAmount, unitMappings),
        )}
      </CellEditTrigger>
      {edit.isEditing && (
        <CellEditorOverlay
          anchorEl={edit.triggerRef.current}
          onRequestCancel={edit.cancel}
        >
          <div className="inline-flex items-center gap-2">
            <Input
              type="number"
              value={editingValue}
              onChange={(e) => setEditingValue(parseFloat(e.target.value) || 0)}
              onKeyDown={handleKeyDown}
              className="h-7 w-20"
              step="any"
              autoFocus
              disabled={isPending}
            />
            <Input
              type="text"
              value={editingUnit}
              onChange={(e) => setEditingUnit(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-7 w-20"
              placeholder="unit"
              disabled={isPending}
            />
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void save()}
              disabled={isPending}
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={edit.cancel}
              disabled={isPending}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </CellEditorOverlay>
      )}
    </>
  );
}
