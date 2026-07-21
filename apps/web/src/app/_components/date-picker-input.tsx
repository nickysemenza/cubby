"use client";

import { format } from "date-fns";
import { CalendarIcon, X } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
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
  onChange: (value: string | null) => void;
  placeholder?: string;
  /** Show a clear (X) affordance when a value is set. Default `false`. */
  clearable?: boolean;
  /** Open the picker immediately on mount (mirrors `<Input autoFocus />`). */
  autoFocus?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * An input-styled trigger that opens a `Calendar` popover for picking a
 * "YYYY-MM-DD" plain date. Dates only ever pass through this component as
 * that string — `Date` objects exist transiently for the picker itself, via
 * the shared local-midnight `parsePlainDate`/`formatPlainDate` helpers.
 */
export function DatePickerInput({
  value,
  onChange,
  placeholder = "Select date…",
  clearable = false,
  autoFocus = false,
  className,
  "aria-label": ariaLabel,
}: DatePickerInputProps) {
  const [open, setOpen] = useState(autoFocus);
  const selected = value ? parsePlainDate(value) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-1 rounded-none border border-border bg-input/20 pr-1 pl-2 transition-colors focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/30 hover:bg-input/30 max-sm:h-10",
          className,
        )}
      >
        <PopoverTrigger
          aria-label={ariaLabel ?? placeholder}
          autoFocus={autoFocus}
          className="inline-flex min-w-0 flex-1 items-center gap-1 text-left text-sm outline-none max-sm:text-base"
        >
          <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "truncate font-mono",
              !selected && "font-sans text-muted-foreground",
            )}
          >
            {selected ? format(selected, "MMM d, yyyy") : placeholder}
          </span>
        </PopoverTrigger>
        {clearable && value && (
          <button
            type="button"
            aria-label="Clear date"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onChange(null)}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <PopoverContent align="start" className="w-auto p-0">
        <Suspense
          fallback={
            <div className="p-4 text-muted-foreground text-xs">Loading…</div>
          }
        >
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            onSelect={(day) => {
              onChange(day ? formatPlainDate(day) : null);
              setOpen(false);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
