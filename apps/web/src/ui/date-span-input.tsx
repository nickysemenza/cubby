import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import { Suspense, type ComponentProps, type Ref, useState } from "react";
import type { DateRange } from "react-day-picker";

import { browserOnlyLazy } from "~/lib/browser-only-lazy";
import { formatCalendarDay } from "~/lib/date-format";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import { Picker } from "~/ui/combobox/picker";
import { DatePickerInput } from "~/ui/date-picker-input";
import { Button } from "~/ui/primitives/button";
import type { Calendar as CalendarComponent } from "~/ui/primitives/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

const Calendar = browserOnlyLazy<ComponentProps<typeof CalendarComponent>>(
  import.meta.env.SSR
    ? null
    : () =>
        import("~/ui/primitives/calendar").then((module) => ({
          default: module.Calendar,
        })),
);

/** One editor for a declared pair of plain dates; never converts through UTC. */
export function DateSpanInput({
  start,
  end,
  onChange,
  onBlur,
  label,
  id,
  clearable = true,
  semantics = "deadline",
  invalid = false,
  describedBy,
  inputRef,
}: {
  start: string | null;
  end: string | null;
  onChange: (value: { start: string | null; end: string | null }) => void;
  onBlur?: () => void;
  label: string;
  id: string;
  clearable?: boolean;
  semantics?: "deadline" | "period";
  invalid?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"single" | "range">(
    semantics === "period" || end ? "range" : "single",
  );
  const from = start ? parsePlainDate(start) : undefined;
  const to = end ? parsePlainDate(end) : undefined;
  const summary = start
    ? `${semantics === "period" && !end ? "From " : ""}${formatCalendarDay(start, "dateShort")}${end ? ` – ${formatCalendarDay(end, "dateShort")}` : ""}`
    : end
      ? `Through ${formatCalendarDay(end, "dateShort")}`
      : `Choose ${label.toLowerCase()}…`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setMode(semantics === "period" || end ? "range" : "single");
        else onBlur?.();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            ref={inputRef}
            id={id}
            variant="outline"
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className="w-full justify-start font-normal"
          />
        }
      >
        <CalendarIcon aria-hidden className="size-3.5 text-muted-foreground" />
        {summary}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)]">
        {semantics === "deadline" && (
          <Picker
            mode="segmented"
            label={`${label} selection`}
            options={[
              { value: "single", label: "Single date" },
              { value: "range", label: "Date range" },
            ]}
            value={mode}
            onValueChange={(next) => {
              if (next !== "single" && next !== "range") return;
              setMode(next);
              if (next === "single") onChange({ start, end: null });
            }}
          />
        )}
        <div
          className={mode === "range" ? "grid grid-cols-2 gap-2" : "grid gap-2"}
        >
          <label htmlFor={`${id}-start`} className="space-y-1 text-xs">
            <span>{mode === "range" ? "Start" : "Date"}</span>
            <DatePickerInput
              id={`${id}-start`}
              required={!clearable}
              aria-label={`${label} start`}
              value={start}
              onChange={(date) =>
                onChange({ start: date, end: mode === "single" ? null : end })
              }
            />
          </label>
          {mode === "range" && (
            <label htmlFor={`${id}-end`} className="space-y-1 text-xs">
              <span>End (optional)</span>
              <DatePickerInput
                id={`${id}-end`}
                aria-label={`${label} end`}
                value={end}
                min={start ?? undefined}
                onChange={(date) => onChange({ start, end: date })}
              />
            </label>
          )}
        </div>
        <Suspense
          fallback={
            <p className="p-3 text-xs text-muted-foreground">
              Loading calendar…
            </p>
          }
        >
          {mode === "range" ? (
            <Calendar
              mode="range"
              required={!clearable}
              defaultMonth={from ?? to}
              selected={{ from, to }}
              onSelect={(range: DateRange | undefined) =>
                onChange({
                  start: range?.from ? formatPlainDate(range.from) : null,
                  end: range?.to ? formatPlainDate(range.to) : null,
                })
              }
            />
          ) : (
            <Calendar
              mode="single"
              required={!clearable}
              defaultMonth={from}
              selected={from}
              onSelect={(date: Date | undefined) =>
                onChange({
                  start: date ? formatPlainDate(date) : null,
                  end: null,
                })
              }
            />
          )}
        </Suspense>
        <div className="flex items-center justify-between gap-2 border-t pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!clearable || (!start && !end)}
            onClick={() => onChange({ start: null, end: null })}
          >
            Clear dates
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setOpen(false);
              onBlur?.();
            }}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
