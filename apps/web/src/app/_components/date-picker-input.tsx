"use client";

import { format } from "date-fns";
import { CalendarIcon, X } from "lucide-react";
import {
  type FocusEvent,
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import { parsePlainDateInput } from "~/lib/plain-date-input";
import { cn } from "~/lib/utils";

// Keep react-day-picker out of the critical chunk — it's only needed once the
// popover actually opens.
const Calendar = lazy(() =>
  import("~/components/ui/calendar").then((mod) => ({
    default: mod.Calendar,
  })),
);

interface DatePickerInputProps {
  /** A "YYYY-MM-DD" plain-date string, or `null` when unset. */
  value: string | null;
  /** Called only with a valid canonical plain date or `null`. */
  onChange: (value: string | null) => void;
  placeholder?: string;
  /** Show a clear (X) affordance when text is present. Default `false`. */
  clearable?: boolean;
  /** Focus the editable text input on mount. */
  focusOnMount?: boolean;
  /** Seed text used by spreadsheet-style type-to-edit. */
  initialText?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  /** Inclusive lower bound as a canonical plain date. */
  min?: string;
  /** Inclusive upper bound as a canonical plain date. */
  max?: string;
  onBlur?: () => void;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

const displayValue = (value: string | null) =>
  value ? format(parsePlainDate(value), "MMM d, yyyy") : "";

const displayedDraftDate = (draft: string, value: string | null) => {
  const parsed = parsePlainDateInput(draft);
  if (parsed.ok && parsed.value) return parsePlainDate(parsed.value);
  return value ? parsePlainDate(value) : undefined;
};

const DateClearButton = ({
  visible,
  disabled,
  onClear,
}: {
  visible: boolean;
  disabled: boolean;
  onClear: () => void;
}) => {
  if (!visible) {
    return <span aria-hidden className="h-full w-7 shrink-0 max-sm:w-10" />;
  }
  return (
    <button
      type="button"
      aria-label="Clear date"
      disabled={disabled}
      className="inline-flex h-full w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50 max-sm:w-10"
      onClick={onClear}
    >
      <X className="size-3.5" />
    </button>
  );
};

/**
 * A dual-mode plain-date field: type or paste an English-US date expression,
 * or use the calendar button. Dates only leave the component as canonical
 * "YYYY-MM-DD" strings; transient `Date` objects always use local time.
 */
export function DatePickerInput({
  value,
  onChange,
  placeholder = "Type or select date…",
  clearable = false,
  focusOnMount = false,
  initialText,
  id,
  name,
  disabled = false,
  required = false,
  min,
  max,
  onBlur,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid = false,
}: DatePickerInputProps) {
  const generatedId = useId();
  const errorId = `${id ?? generatedId}-error`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousValueRef = useRef(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(
    initialText === undefined ? displayValue(value) : initialText,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (previousValueRef.current === value) return;
    previousValueRef.current = value;
    setDraft(displayValue(value));
    setError(null);
    inputRef.current?.setCustomValidity("");
  }, [value]);

  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);

  const draftDate = useMemo(
    () => displayedDraftDate(draft, value),
    [draft, value],
  );

  const clearError = () => {
    setError(null);
    inputRef.current?.setCustomValidity("");
  };

  const commitDraft = () => {
    const parsed = parsePlainDateInput(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      inputRef.current?.setCustomValidity(parsed.error);
      return false;
    }

    if (required && !parsed.value) {
      const message = "Enter a date.";
      setError(message);
      inputRef.current?.setCustomValidity(message);
      return false;
    }

    if (parsed.value && min && parsed.value < min) {
      const message = `Enter a date on or after ${displayValue(min)}.`;
      setError(message);
      inputRef.current?.setCustomValidity(message);
      return false;
    }

    if (parsed.value && max && parsed.value > max) {
      const message = `Enter a date on or before ${displayValue(max)}.`;
      setError(message);
      inputRef.current?.setCustomValidity(message);
      return false;
    }

    clearError();
    setDraft(displayValue(parsed.value));
    onChange(parsed.value);
    return true;
  };

  const applyValue = (nextValue: string | null) => {
    clearError();
    setDraft(displayValue(nextValue));
    onChange(nextValue);
  };

  const restoreCommittedValue = () => {
    clearError();
    setDraft(displayValue(value));
  };

  const isPickerElement = (element: Element | null) =>
    Boolean(
      element &&
      (rootRef.current?.contains(element) ||
        element.closest('[data-slot="popover-content"]')),
    );

  const handleCompositeBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (isPickerElement(event.relatedTarget)) return;
    // The calendar owns focus while open. If it closes because focus moved
    // elsewhere, handleOpenChange performs the deferred composite commit.
    if (open) return;
    commitDraft();
    onBlur?.();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    queueMicrotask(() => {
      if (isPickerElement(document.activeElement)) return;
      commitDraft();
      onBlur?.();
    });
  };

  const describedBy =
    [ariaDescribedBy, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  const invalid = ariaInvalid || Boolean(error);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div
        ref={rootRef}
        className={cn("w-full min-w-0", className)}
        onBlur={handleCompositeBlur}
      >
        <div
          className={cn(
            "flex h-7 w-full min-w-0 items-center rounded-none border border-border bg-input/20 transition-colors focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/30 hover:bg-input/30 max-sm:h-10",
            invalid &&
              "border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
          )}
        >
          <input
            ref={inputRef}
            id={id}
            name={name}
            type="text"
            required={required}
            value={draft}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={ariaLabel ?? (id ? undefined : placeholder)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent px-2 py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 max-sm:text-base"
            onChange={(event) => {
              setDraft(event.target.value);
              clearError();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitDraft();
              } else if (event.key === "Escape") {
                event.preventDefault();
                restoreCommittedValue();
              }
            }}
          />
          {clearable && !required && (
            <DateClearButton
              visible={draft !== ""}
              disabled={disabled}
              onClear={() => applyValue(null)}
            />
          )}
          <PopoverTrigger
            aria-label="Open calendar"
            disabled={disabled}
            className="inline-flex h-full w-7 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-input/40 hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 max-sm:w-10"
          >
            <CalendarIcon className="size-3.5" />
          </PopoverTrigger>
        </div>
        {error && (
          <p
            id={errorId}
            role="alert"
            className="mt-1 text-xs text-destructive"
          >
            {error}
          </p>
        )}
      </div>
      <PopoverContent align="start" className="w-auto p-0">
        <Suspense
          fallback={
            <div className="p-4 text-xs text-muted-foreground">Loading…</div>
          }
        >
          <Calendar
            mode="single"
            required={required}
            selected={draftDate}
            defaultMonth={draftDate}
            disabled={[
              ...(min ? [{ before: parsePlainDate(min) }] : []),
              ...(max ? [{ after: parsePlainDate(max) }] : []),
            ]}
            onSelect={(day: Date | undefined) => {
              if (!day && required) return;
              applyValue(day ? formatPlainDate(day) : null);
              setOpen(false);
              inputRef.current?.focus();
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
