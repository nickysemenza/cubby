"use client";

import { Check, Pencil, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  FilterableCombobox,
  type FilterableComboboxItem,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";
import { NoneState } from "../NoneState";

// ============================================================================
// Types
// ============================================================================

/** Re-export for convenience */
export type { FilterableComboboxItem };

type EditableInputConfig = {
  type: "text" | "number";
  prefix?: string;
  step?: string;
  placeholder?: string;
};

type EditableCurrencyConfig = {
  type: "currency";
};

type EditableSelectConfig = {
  type: "select";
  options: FilterableComboboxItem[];
  placeholder?: string;
};

export type EditableConfig =
  | EditableInputConfig
  | EditableCurrencyConfig
  | EditableSelectConfig;

// ============================================================================
// Shared Hook: useOptimisticEditing
// ============================================================================

/**
 * Shared hook for optimistic editing state management.
 * Used by both text input and select cell implementations.
 */
function useOptimisticEditing<T>(
  value: T | null,
  onSave: (value: T | null) => Promise<void>,
) {
  const [isEditing, setIsEditing] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [optimisticValue, setOptimisticValue] = useState<T | null | undefined>(
    undefined,
  );

  const displayValue = optimisticValue !== undefined ? optimisticValue : value;

  const cancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const saveValue = useCallback(
    async (newValue: T | null, skipIfUnchanged: boolean) => {
      if (skipIfUnchanged && newValue === value) {
        setIsEditing(false);
        return;
      }

      setIsPending(true);
      try {
        await onSave(newValue);
        setOptimisticValue(newValue);
        setIsEditing(false);
      } catch (err) {
        toast.error(getErrorMessage(err));
      } finally {
        setIsPending(false);
      }
    },
    [value, onSave],
  );

  // Clear optimistic value when real value catches up
  useEffect(() => {
    if (optimisticValue !== undefined && value === optimisticValue) {
      setOptimisticValue(undefined);
    }
  }, [value, optimisticValue]);

  return {
    isEditing,
    setIsEditing,
    isPending,
    displayValue,
    optimisticValue,
    cancel,
    saveValue,
  };
}

// ============================================================================
// Hook: useEditableCell
// ============================================================================

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
  const [inputValue, setInputValue] = useState("");

  const {
    isEditing,
    setIsEditing,
    isPending,
    displayValue,
    optimisticValue,
    cancel,
    saveValue,
  } = useOptimisticEditing(value, onSave);

  const startEditing = useCallback(() => {
    const v = optimisticValue !== undefined ? optimisticValue : value;
    if (format && v !== null) {
      setInputValue(format(v));
    } else {
      setInputValue(v !== null ? String(v) : "");
    }
    setIsEditing(true);
  }, [value, optimisticValue, format, setIsEditing]);

  const save = useCallback(async () => {
    const trimmed = inputValue.trim();
    const parsed = trimmed === "" ? null : parse ? parse(trimmed) : null;

    // Skip if value hasn't changed
    const skipIfUnchanged = parsed === null && value === null;
    await saveValue(parsed, skipIfUnchanged || parsed === value);
  }, [inputValue, parse, value, saveValue]);

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
  };
}

// ============================================================================
// Hook: useEditableSelectCell (specialized for select type)
// ============================================================================

interface UseEditableSelectCellOptions {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
}

function useEditableSelectCell({
  value,
  onSave,
}: UseEditableSelectCellOptions) {
  const [selectedValue, setSelectedValue] = useState<string | null>(value);

  const {
    isEditing,
    setIsEditing,
    isPending,
    displayValue,
    optimisticValue,
    cancel,
    saveValue,
  } = useOptimisticEditing(value, onSave);

  const startEditing = useCallback(() => {
    const v = optimisticValue !== undefined ? optimisticValue : value;
    setSelectedValue(v);
    setIsEditing(true);
  }, [value, optimisticValue, setIsEditing]);

  const save = useCallback(async () => {
    await saveValue(selectedValue, selectedValue === value);
  }, [selectedValue, value, saveValue]);

  return {
    isEditing,
    selectedValue,
    setSelectedValue,
    displayValue,
    isPending,
    startEditing,
    cancel,
    save,
  };
}

// ============================================================================
// Component: EditableCell (unified)
// ============================================================================

interface EditableCellProps<T> {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  config: EditableConfig;
  renderValue: (value: T | null) => React.ReactNode;
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
    />
  );
}

// ============================================================================
// Internal: EditableInputCellInternal (text, number, currency)
// ============================================================================

function EditableInputCellInternal<T>({
  value,
  onSave,
  config,
  renderValue,
}: {
  value: T | null;
  onSave: (value: T | null) => Promise<void>;
  config: EditableInputConfig | EditableCurrencyConfig;
  renderValue: (value: T | null) => React.ReactNode;
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

  const {
    isEditing,
    inputValue,
    setInputValue,
    displayValue,
    isPending,
    startEditing,
    cancel,
    save,
    handleKeyDown,
  } = useEditableCell({ value, onSave, parse, format });

  if (isEditing) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation for row click
      <div
        className="inline-flex items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        {prefix && (
          <span className="text-muted-foreground text-sm">{prefix}</span>
        )}
        <Input
          type={inputType}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-7 w-24"
          step={step}
          placeholder={placeholder}
          autoFocus
          disabled={isPending}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => void save()}
          disabled={isPending}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={cancel}
          disabled={isPending}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="group inline-flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted"
      onClick={(e) => {
        e.stopPropagation();
        startEditing();
      }}
    >
      {renderValue(displayValue)}
      <Pencil className="ml-1 h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// ============================================================================
// Internal: EditableSelectCellInternal
// ============================================================================

function EditableSelectCellInternal({
  value,
  onSave,
  options,
  placeholder = "Select...",
  renderValue,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  options: FilterableComboboxItem[];
  placeholder?: string;
  renderValue: (value: string | null) => React.ReactNode;
}) {
  const {
    isEditing,
    selectedValue,
    setSelectedValue,
    displayValue,
    isPending,
    startEditing,
    cancel,
    save,
  } = useEditableSelectCell({ value, onSave });

  if (isEditing) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation for row click
      <div
        className="inline-flex items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <FilterableCombobox
          items={options}
          value={selectedValue}
          onValueChange={setSelectedValue}
          placeholder={placeholder}
          disabled={isPending}
          className="w-40"
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => void save()}
          disabled={isPending}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={cancel}
          disabled={isPending}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="group inline-flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted"
      onClick={(e) => {
        e.stopPropagation();
        startEditing();
      }}
    >
      {renderValue(displayValue)}
      <Pencil className="ml-1 h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// ============================================================================
// Legacy exports (deprecated - use EditableCell with config instead)
// ============================================================================

/**
 * @deprecated Use EditableCell with config={{ type: "currency" }} instead
 */
export function EditableCurrencyCell({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (newValue: number | null) => Promise<void>;
}) {
  return (
    <EditableCell
      value={value}
      onSave={onSave}
      config={{ type: "currency" }}
      renderValue={(v) => (v !== null ? formatCurrency(v) : <NoneState />)}
    />
  );
}

/**
 * @deprecated Use EditableCell with config={{ type: "select", options }} instead
 */
export function EditableSelectCell({
  value,
  options,
  onSave,
  renderValue,
  placeholder = "Select...",
}: {
  value: string | null;
  options: FilterableComboboxItem[];
  onSave: (newValue: string | null) => Promise<void>;
  renderValue: (value: string | null) => React.ReactNode;
  placeholder?: string;
}) {
  return (
    <EditableCell
      value={value}
      onSave={onSave}
      config={{ type: "select", options, placeholder }}
      renderValue={renderValue}
    />
  );
}
