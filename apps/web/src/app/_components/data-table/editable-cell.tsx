"use client";

import { Check, Pencil, X } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { formatCurrency } from "~/lib/utils";
import { NoneState } from "../NoneState";

interface EditableCellProps<T> {
  value: T | null;
  onSave: (newValue: T | null) => Promise<void>;
  /** Format the value for display. Defaults to String(value). */
  format?: (value: T) => string;
  /** Parse the input string back to T. Return null for empty/invalid. */
  parse?: (input: string) => T | null;
  inputType?: "text" | "number";
  /** Prefix to show before the input (e.g., "$") */
  prefix?: string;
  placeholder?: string;
  className?: string;
  /** Input step for number inputs */
  step?: string;
}

export function EditableCell<T>({
  value,
  onSave,
  format = (v) => String(v),
  parse = (s) => (s ? (s as unknown as T) : null),
  inputType = "text",
  prefix,
  placeholder,
  step,
}: EditableCellProps<T>) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [isPending, setIsPending] = useState(false);

  const startEditing = useCallback(() => {
    setInputValue(value !== null ? String(value) : "");
    setIsEditing(true);
  }, [value]);

  const cancel = useCallback(() => {
    setIsEditing(false);
    setInputValue("");
  }, []);

  const save = useCallback(async () => {
    const trimmed = inputValue.trim();
    const newValue = trimmed === "" ? null : parse(trimmed);

    // Skip if value hasn't changed
    if (newValue === value || (newValue === null && value === null)) {
      setIsEditing(false);
      return;
    }

    setIsPending(true);
    try {
      await onSave(newValue);
      setIsEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsPending(false);
    }
  }, [inputValue, parse, value, onSave]);

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

  if (isEditing) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation for row click
      <div
        className="flex items-center gap-1"
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
      className="group flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted"
      onClick={(e) => {
        e.stopPropagation(); // Prevent row click
        startEditing();
      }}
    >
      {value !== null ? format(value) : <NoneState />}
      <Pencil className="ml-1 h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/**
 * Convenience wrapper for editing currency values.
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
      format={formatCurrency}
      parse={(s) => {
        const num = parseFloat(s);
        return Number.isNaN(num) ? null : num;
      }}
      inputType="number"
      prefix="$"
      placeholder="0.00"
      step="0.01"
    />
  );
}
