"use client";

import type { Amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { Check, Pencil, RotateCcw, X } from "lucide-react";
import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import type { FieldSuggestionSource } from "~/app/_components/ai/field-suggestion";
import { FieldSuggestionApply } from "~/app/_components/ai/field-suggestion-apply";
import { Button } from "~/components/ui/button";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { focusOnMount } from "~/hooks/focus-on-mount";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

import { StaticPicker } from "../combobox/static-picker";
import { DatePickerInput } from "../date-picker-input";
import {
  showAmountAndPrice,
  tryFormatAmount,
} from "../inventory/format-amount";
import type { CellClipboardSpec, CellPastePayload } from "./cell-clipboard";
import { CellEditTrigger } from "./cell-edit-trigger";
import { CellEditorOverlay } from "./cell-editor-overlay";
import { CELL_EDIT_GROUP_CLASS, CELL_EDIT_PENCIL_CLASS } from "./cell-frame";
import { CellSelectionContext } from "./cell-selection-context";

export type { FilterableComboboxItem };

/**
 * The editor owns retry behavior, while the host owns how its failure is
 * surfaced. The default keeps browser behavior on Sonner; tests and embedded
 * hosts can provide a faithful notification destination without replacing a
 * module.
 */
export interface EditorNotificationPort {
  showError: (message: string) => void;
}

const sonnerEditorNotifications: EditorNotificationPort = {
  showError: (message) => toast.error(message),
};

export const EditorNotificationContext = createContext<EditorNotificationPort>(
  sonnerEditorNotifications,
);

type EditableTextConfig = {
  type: "text";
  prefix?: string;
  step?: string;
  placeholder?: string;
  /**
   * Text-only: render a multi-line <Textarea> editor instead of a single-line
   * <Input>. Commits on blur / Cmd+Enter, cancels on Escape (plain Enter
   * inserts a newline). No-op for `type: "number"`.
   */
  multiline?: boolean;
  rows?: number;
};

type EditableNumberConfig = {
  type: "number";
  prefix?: string;
  step?: string;
  placeholder?: string;
};

type EditableCurrencyConfig = {
  type: "currency";
  /**
   * Offer an explicit clear control beside Save/Cancel that saves null
   * directly, instead of requiring "empty the box, then Save". Needed for a
   * field with a fallback — `Product.price` overrides an Expense-derived
   * price, so an emptied box and a value that merely happens to equal the
   * fallback are visually identical. `label` names the state clearing lands
   * on (e.g. "Revert to $12.00 (derived)") and doubles as the button's
   * accessible name and tooltip, so the control reads as a choice rather
   * than an unlabelled "clear".
   */
  clearable?: { label: string };
};

type EditableSelectConfig = {
  type: "select";
  options: FilterableComboboxItem[];
  placeholder?: string;
  /**
   * Offer the picker's clear affordance, so a nullable column can be returned
   * to null. Needed by any tri-state field — `Product.stockTracked` encodes
   * "undecided" as null, and without this the editor could only ever move a row
   * *out* of the undecided worklist, never back in.
   */
  clearable?: boolean;
  /** When the field's `control.suggest` exists — queries only while the
   * editor is open (`EditableSelectEditor` mounts `FieldSuggestionApply`
   * beneath the picker), never at rest. */
  suggest?: FieldSuggestionSource;
};

type EditableDateConfig = {
  type: "date";
  clearable?: boolean;
  clearLabel?: string;
  clearDisabledReason?: string | undefined;
  placeholder?: string;
};

interface EditableCellCommonProps<T> {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  renderValue: (value: T | null) => React.ReactNode;
  clipboard?: CellClipboardSpec<T | null>;
  trigger?: "wrap" | "pencil";
  autoOpen?: boolean;
}

type EditableTextCellProps = EditableCellCommonProps<string> & {
  config: EditableTextConfig;
};

type EditableNumberCellProps = EditableCellCommonProps<number> & {
  config: EditableNumberConfig;
};

type EditableSelectCellProps<T extends string = string> =
  EditableCellCommonProps<T> & {
    config: EditableSelectConfig;
  };

type EditableDateCellProps = EditableCellCommonProps<string> & {
  config: EditableDateConfig;
};

type EditableCurrencyCellProps = EditableCellCommonProps<number> & {
  config: EditableCurrencyConfig;
};

type EditableCellProps =
  | EditableTextCellProps
  | EditableNumberCellProps
  | EditableSelectCellProps
  | EditableDateCellProps
  | EditableCurrencyCellProps;

function isSelectCellProps(
  props: EditableCellProps,
): props is EditableSelectCellProps {
  return props.config.type === "select";
}

function isDateCellProps(
  props: EditableCellProps,
): props is EditableDateCellProps {
  return props.config.type === "date";
}

function isTextCellProps(
  props: EditableCellProps,
): props is EditableTextCellProps {
  return props.config.type === "text";
}

export function EditableCell(props: EditableTextCellProps): React.ReactNode;
export function EditableCell(props: EditableNumberCellProps): React.ReactNode;
export function EditableCell<T extends string>(
  props: EditableSelectCellProps<T>,
): React.ReactNode;
export function EditableCell(props: EditableDateCellProps): React.ReactNode;
export function EditableCell(props: EditableCurrencyCellProps): React.ReactNode;
export function EditableCell(props: EditableCellProps) {
  if (isSelectCellProps(props)) {
    const { config } = props;
    return (
      <EditableSelectCellInternal
        value={props.value}
        onSave={props.onSave}
        options={config.options}
        placeholder={config.placeholder}
        clearable={config.clearable}
        suggest={config.suggest}
        renderValue={props.renderValue}
        clipboard={props.clipboard}
        trigger={props.trigger ?? "wrap"}
        autoOpen={props.autoOpen ?? false}
      />
    );
  }

  if (isDateCellProps(props)) {
    const { config } = props;
    return (
      <EditableDateCellInternal
        clearable={config.clearable}
        clearLabel={config.clearLabel}
        clearDisabledReason={config.clearDisabledReason}
        value={props.value}
        onSave={props.onSave}
        placeholder={config.placeholder}
        renderValue={props.renderValue}
        clipboard={props.clipboard}
        trigger={props.trigger ?? "wrap"}
        autoOpen={props.autoOpen ?? false}
      />
    );
  }

  if (isTextCellProps(props)) {
    const { config } = props;
    return (
      <EditableInputCellInternal
        value={props.value}
        onSave={props.onSave}
        config={config}
        parseValue={(value) => value}
        renderValue={props.renderValue}
        clipboard={props.clipboard}
        trigger={props.trigger ?? "wrap"}
        autoOpen={props.autoOpen ?? false}
      />
    );
  }

  const { config } = props;
  return (
    <EditableInputCellInternal
      value={props.value}
      onSave={props.onSave}
      config={config}
      parseValue={(value) => {
        const parsed = Number.parseFloat(value);
        return Number.isNaN(parsed) ? null : parsed;
      }}
      renderValue={props.renderValue}
      clipboard={props.clipboard}
      trigger={props.trigger ?? "wrap"}
      autoOpen={props.autoOpen ?? false}
    />
  );
}

export function useCellEditState<TSaved = void>(
  clipboard: CellClipboardSpec<TSaved> | undefined,
  onPasted?: (value: TSaved) => void,
) {
  const [isEditing, setIsEditing] = useState(false);
  // Type-to-edit seed (a printable char that opened the editor), captured at
  // open and cleared on cancel/commit. Held here — the ONE place — so every
  // editor reads it the same way instead of re-plumbing the CustomEvent.
  const [seedText, setSeedText] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const isEditingRef = useRef(false);
  isEditingRef.current = isEditing;

  const open = useCallback((seed?: string) => {
    setSeedText(seed ?? null);
    setIsEditing(true);
  }, []);

  const cancel = useCallback(() => {
    setIsEditing(false);
    setSeedText(null);
    triggerRef.current?.focus();
  }, []);

  // In cell-selection mode the range engine (useCellSelection) owns ALL
  // copy/paste and CellEditTrigger skips the per-element registration, so the
  // guard wrapper + its closures would be dead weight allocated every render.
  // Drop the spec here so the spread/closures below never run in a table.
  const cellSelectionMode = useContext(CellSelectionContext);
  const effectiveClipboard = cellSelectionMode ? undefined : clipboard;

  const pasteThrough = effectiveClipboard?.onPasteValue;
  const clipboardWithGuard = effectiveClipboard
    ? {
        ...effectiveClipboard,
        isEditing: () => isEditingRef.current,
        onPasteValue: pasteThrough
          ? async (payload: CellPastePayload) => {
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

type EditTriggerMode = "wrap" | "pencil";

function EditableDisplay<TSaved>({
  mode,
  triggerRef,
  onStartEdit,
  clipboard,
  children,
}: {
  mode: EditTriggerMode;
  triggerRef: React.Ref<HTMLButtonElement>;
  onStartEdit: (seedText?: string) => void;
  clipboard?: CellClipboardSpec<TSaved>;
  children: React.ReactNode;
}) {
  if (mode === "pencil") {
    return (
      <span className={CELL_EDIT_GROUP_CLASS}>
        <span className="min-w-0 truncate">{children}</span>
        <CellEditTrigger
          ref={triggerRef}
          onStartEdit={onStartEdit}
          clipboard={clipboard}
          hidePencilIcon
          aria-label="Edit value"
          className={CELL_EDIT_PENCIL_CLASS}
        >
          <Pencil className="size-3 text-muted-foreground pointer-coarse:text-hairline" />
        </CellEditTrigger>
      </span>
    );
  }

  return (
    <CellEditTrigger
      ref={triggerRef}
      onStartEdit={onStartEdit}
      clipboard={clipboard}
    >
      {children}
    </CellEditTrigger>
  );
}

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

/**
 * The one commit body shared by every inline editor (input / select / date /
 * amount / entity / tags). Owns the mid-save lifecycle: an `isPending` flag for
 * disabling the widget, a `pendingRef` re-entrancy guard so a fast second commit
 * can't fire a concurrent `onSave` (previously only the entity editor had this —
 * generalizing it closes the same double-fire hazard everywhere), the
 * unchanged→cancel short-circuit, and the toast-on-error path that leaves the
 * editor open for a retry.
 *
 * Each editor keeps its own widget, draft state, and unchanged predicate — it
 * passes the predicate result as `opts.unchanged` at the call site.
 */
interface EditorCommit<T> {
  isPending: boolean;
  commit: (next: T, opts?: { unchanged?: boolean }) => Promise<void>;
}

export function useEditorCommit<T>(args: {
  onSave: (next: T) => Promise<void>;
  onCommit: (next: T) => void;
  onCancel: () => void;
}): EditorCommit<T> {
  const { onSave, onCommit, onCancel } = args;
  const notifications = useContext(EditorNotificationContext);
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);

  const commit = useCallback(
    async (next: T, opts?: { unchanged?: boolean }) => {
      // Hard re-entrancy guard: a widget that closes synchronously on commit
      // (e.g. a combobox pick) could otherwise dispatch a second commit before
      // the first save resolves.
      if (pendingRef.current) return;
      if (opts?.unchanged) {
        onCancel();
        return;
      }

      pendingRef.current = true;
      setIsPending(true);
      try {
        await onSave(next);
        onCommit(next);
      } catch (err) {
        // Stay open with state intact so the user can retry or cancel.
        notifications.showError(getErrorMessage(err));
      } finally {
        pendingRef.current = false;
        setIsPending(false);
      }
    },
    [onSave, onCommit, onCancel, notifications],
  );

  return { isPending, commit };
}

function EditableInputCellInternal<T>({
  value,
  onSave,
  config,
  parseValue,
  renderValue,
  clipboard,
  trigger,
  autoOpen,
}: {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  config: EditableTextConfig | EditableNumberConfig | EditableCurrencyConfig;
  parseValue: (value: string) => T | null;
  renderValue: (value: T | null) => React.ReactNode;
  clipboard?: CellClipboardSpec<T | null>;
  trigger: EditTriggerMode;
  autoOpen: boolean;
}) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(value);
  const edit = useCellEditState(clipboard, setOptimisticValue);

  useEffect(() => {
    if (autoOpen) edit.open();
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [autoOpen, edit.open]);

  // Money and numbers are measurements, same as dates: mono + tabular, which is
  // what `meta.numeric` already gives the equivalent table COLUMN. Free text
  // keeps the prose face.
  const measured = config.type === "currency" || config.type === "number";

  return (
    <>
      <EditableDisplay
        mode={trigger}
        triggerRef={edit.triggerRef}
        onStartEdit={edit.open}
        clipboard={edit.clipboard}
      >
        {measured ? (
          <span className="tabular-nums">{renderValue(displayValue)}</span>
        ) : (
          renderValue(displayValue)
        )}
      </EditableDisplay>
      {edit.isEditing && (
        <CellEditorOverlay
          anchorEl={edit.triggerRef.current}
          onRequestCancel={edit.cancel}
        >
          <EditableInputEditor
            value={value}
            onSave={onSave}
            config={config}
            parseValue={parseValue}
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
  parseValue,
  seedText,
  onCancel,
  onCommit,
}: {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  config: EditableTextConfig | EditableNumberConfig | EditableCurrencyConfig;
  parseValue: (value: string) => T | null;
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
  const clearLabel =
    config.type === "currency" ? config.clearable?.label : undefined;

  const format = useCallback((v: T): string => {
    return String(v);
  }, []);

  const [inputValue, setInputValue] = useState(() =>
    seedText != null ? seedText : value !== null ? format(value) : "",
  );
  const { isPending, commit } = useEditorCommit<T | null>({
    onSave,
    onCommit,
    onCancel,
  });

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
    const parsed = trimmed === "" ? null : parseValue(trimmed);

    await commit(parsed, {
      unchanged: parsed === value || (parsed === null && value === null),
    });
  }, [inputValue, parseValue, value, commit]);

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
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions -- Inline table-editor controls own keyboard behavior; this wrapper only blocks the row click.
    <div
      className={cn(
        "inline-flex gap-1",
        multiline ? "items-start" : "items-center",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {prefix && (
        <span className="text-sm text-muted-foreground">{prefix}</span>
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
          ref={focusOnMount}
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
          ref={focusOnMount}
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
      {clearLabel && value !== null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon"
                variant="ghost"
                aria-label={clearLabel}
                onClick={() => void commit(null)}
                disabled={isPending}
              />
            }
          >
            <RotateCcw className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="top">{clearLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function EditableSelectCellInternal({
  value,
  onSave,
  options,
  placeholder = "Select...",
  clearable,
  suggest,
  renderValue,
  clipboard,
  trigger,
  autoOpen,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  options: FilterableComboboxItem[];
  placeholder?: string;
  clearable?: boolean;
  suggest?: FieldSuggestionSource;
  renderValue: (value: string | null) => React.ReactNode;
  clipboard?: CellClipboardSpec<string | null>;
  trigger: EditTriggerMode;
  autoOpen: boolean;
}) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(value);
  const edit = useCellEditState(clipboard, setOptimisticValue);

  useEffect(() => {
    if (autoOpen) edit.open();
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [autoOpen, edit.open]);

  return (
    <>
      <EditableDisplay
        mode={trigger}
        triggerRef={edit.triggerRef}
        onStartEdit={edit.open}
        clipboard={edit.clipboard}
      >
        {renderValue(displayValue)}
      </EditableDisplay>
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
            clearable={clearable}
            suggest={suggest}
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

function EditableSelectEditor({
  value,
  onSave,
  options,
  placeholder,
  clearable,
  suggest,
  onCancel,
  onCommit,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  options: FilterableComboboxItem[];
  placeholder: string;
  clearable?: boolean;
  suggest?: FieldSuggestionSource;
  onCancel: () => void;
  onCommit: (value: string | null) => void;
}) {
  const { isPending, commit } = useEditorCommit<string | null>({
    onSave,
    onCommit,
    onCancel,
  });

  const handlePick = useCallback(
    (next: string | null) => commit(next, { unchanged: next === value }),
    [value, commit],
  );

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions -- Inline table-editor controls own keyboard behavior; this wrapper only blocks the row click.
    <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <div className="inline-flex items-center gap-1">
        <StaticPicker
          items={options}
          value={value}
          onValueChange={(next) => void handlePick(next)}
          label={placeholder}
          placeholder={placeholder}
          disabled={isPending}
          className="w-48"
          openOnMount
          compact
          clearable={clearable}
          widthMode="intrinsic"
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
      {suggest && (
        <FieldSuggestionApply
          source={suggest}
          currentValue={value}
          onApply={(suggestion) => {
            if (suggestion.value) void handlePick(suggestion.value);
          }}
        />
      )}
    </div>
  );
}

function EditableDateCellInternal({
  value,
  onSave,
  placeholder,
  clearable = true,
  clearLabel,
  clearDisabledReason,
  renderValue,
  clipboard,
  trigger,
  autoOpen,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
  clearable?: boolean;
  clearLabel?: string;
  clearDisabledReason?: string | undefined;
  renderValue: (value: string | null) => React.ReactNode;
  clipboard?: CellClipboardSpec<string | null>;
  trigger: EditTriggerMode;
  autoOpen: boolean;
}) {
  const { displayValue, setOptimisticValue } = useOptimisticDisplayValue(value);
  const edit = useCellEditState(clipboard, setOptimisticValue);

  useEffect(() => {
    if (autoOpen) edit.open();
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [autoOpen, edit.open]);

  return (
    <>
      <EditableDisplay
        mode={trigger}
        triggerRef={edit.triggerRef}
        onStartEdit={edit.open}
        clipboard={edit.clipboard}
      >
        {/* Dates are measurements: tabular figures on every surface, so a
            detail-page date and the same value in a table align the same way.
            Mono is reserved for codes and identifiers. */}
        <span className="tabular-nums">{renderValue(displayValue)}</span>
      </EditableDisplay>
      {edit.isEditing && (
        <CellEditorOverlay
          anchorEl={edit.triggerRef.current}
          onRequestCancel={edit.cancel}
          cancelOnOutside={false}
        >
          <EditableDateEditor
            clearable={clearable}
            clearLabel={clearLabel}
            clearDisabledReason={clearDisabledReason}
            value={value}
            onSave={onSave}
            placeholder={placeholder}
            initialText={edit.seedText ?? undefined}
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

function EditableDateEditor({
  value,
  onSave,
  placeholder,
  clearable = true,
  clearLabel,
  clearDisabledReason,
  initialText,
  onCancel,
  onCommit,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
  clearable?: boolean;
  clearLabel?: string;
  clearDisabledReason?: string | undefined;
  initialText?: string;
  onCancel: () => void;
  onCommit: (value: string | null) => void;
}) {
  const { isPending, commit } = useEditorCommit<string | null>({
    onSave,
    onCommit,
    onCancel,
  });

  const handleChange = useCallback(
    (next: string | null) => commit(next, { unchanged: next === value }),
    [value, commit],
  );

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions -- Inline table-editor controls own keyboard behavior; this wrapper only blocks the row click.
    <div
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <DatePickerInput
        value={value}
        onChange={(next) => void handleChange(next)}
        placeholder={placeholder}
        initialText={initialText}
        clearable={clearable}
        required={!clearable}
        focusOnMount
        className={cn("w-40", isPending && "pointer-events-none opacity-50")}
      />
      {clearable && clearLabel ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => void handleChange(null)}
        >
          {clearLabel}
        </Button>
      ) : null}
      {clearDisabledReason ? (
        <span className="text-xs text-muted-foreground">
          {clearDisabledReason}
        </span>
      ) : null}
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
  trigger?: EditTriggerMode;
  clipboard?: CellClipboardSpec<Amount>;
}

export function EditableAmountCell({
  amount,
  unitMappings,
  onSave,
  renderDisplay,
  trigger = "wrap",
  clipboard,
}: EditableAmountCellProps) {
  const [editingValue, setEditingValue] = useState(amount.value);
  const [editingUnit, setEditingUnit] = useState(amount.unit);
  const [optimisticAmount, setOptimisticAmount] = useState<Amount | undefined>(
    undefined,
  );
  const edit = useCellEditState(clipboard, setOptimisticAmount);

  const displayAmount = optimisticAmount ?? amount;

  const onCommit = useCallback(
    (next: Amount) => {
      setOptimisticAmount(next);
      edit.cancel();
    },
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
    [edit.cancel],
  );
  const { isPending, commit } = useEditorCommit<Amount>({
    onSave,
    onCommit,
    onCancel: edit.cancel,
  });

  const startEditing = useCallback(() => {
    const current = optimisticAmount ?? amount;
    setEditingValue(current.value);
    setEditingUnit(current.unit);
    edit.open();
    // oxlint-disable-next-line react/exhaustive-deps -- edit.open is a stable callback
  }, [amount, optimisticAmount]);

  const save = useCallback(async () => {
    const newAmount = { value: editingValue, unit: editingUnit.trim() };
    await commit(newAmount, {
      unchanged:
        newAmount.value === amount.value && newAmount.unit === amount.unit,
    });
  }, [editingValue, editingUnit, amount, commit]);

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
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
    [save, edit.cancel],
  );

  return (
    <>
      <EditableDisplay
        mode={trigger}
        triggerRef={edit.triggerRef}
        onStartEdit={startEditing}
        clipboard={edit.clipboard}
      >
        {(renderDisplay ?? ((content: React.ReactNode) => content))(
          unitMappings === undefined
            ? tryFormatAmount(displayAmount)
            : showAmountAndPrice(displayAmount, unitMappings),
        )}
      </EditableDisplay>
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
              ref={focusOnMount}
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
