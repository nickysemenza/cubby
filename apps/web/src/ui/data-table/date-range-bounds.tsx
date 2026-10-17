import {
  describeRelativeDate,
  formatRangeBounds,
  parseRangeBounds,
  relativeDateOffset,
  relativeDateToken,
} from "@cubby/shared";
import { useState } from "react";

import { Picker } from "~/ui/combobox/picker";
import { Input } from "~/ui/primitives/input";

type BoundMode = "any" | "date" | "relative";

const MODES = [
  { value: "any", label: "Any" },
  { value: "date", label: "Date" },
  { value: "relative", label: "Relative" },
] as const satisfies readonly { value: BoundMode; label: string }[];

const DIRECTIONS = [
  { value: "past", label: "days ago" },
  { value: "future", label: "days ahead" },
];

const modeOf = (bound: string | undefined): BoundMode =>
  bound === undefined
    ? "any"
    : relativeDateOffset(bound) === undefined
      ? "date"
      : "relative";

/**
 * One bound of a date range: none, a calendar day, or a day relative to the
 * household's today (`@today-30d`), which a saved view keeps as the token so
 * it stays current.
 */
function DateBound({
  label,
  bound,
  onChange,
}: {
  label: string;
  bound: string | undefined;
  onChange: (bound: string | undefined) => void;
}) {
  const [mode, setMode] = useState<BoundMode>(() => modeOf(bound));
  const days = bound === undefined ? undefined : relativeDateOffset(bound);
  const relative = days ?? 0;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">
        {label}
      </legend>
      <Picker
        mode="segmented"
        label={`${label} bound`}
        options={MODES}
        value={mode}
        onValueChange={(value) => {
          const next = MODES.find((option) => option.value === value)?.value;
          if (next === undefined) return;
          setMode(next);
          onChange(
            next === "any"
              ? undefined
              : next === "relative"
                ? relativeDateToken(0)
                : undefined,
          );
        }}
      />
      {mode === "date" && (
        <Input
          type="date"
          aria-label={`${label} date`}
          value={bound !== undefined && days === undefined ? bound : ""}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      )}
      {mode === "relative" && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              aria-label={`${label} days`}
              className="w-20 tabular-nums"
              value={Math.abs(relative)}
              onChange={(event) => {
                const count = Math.max(
                  0,
                  Math.trunc(Number(event.target.value)),
                );
                if (!Number.isFinite(count)) return;
                onChange(relativeDateToken(relative > 0 ? count : -count));
              }}
            />
            <Picker
              options={DIRECTIONS}
              label={`${label} direction`}
              value={relative > 0 ? "future" : "past"}
              onValueChange={(value) =>
                onChange(
                  relativeDateToken(
                    value === "future"
                      ? Math.abs(relative)
                      : -Math.abs(relative),
                  ),
                )
              }
              className="flex-1"
            />
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            {describeRelativeDate(relative)}, counted from the household's today
          </p>
        </div>
      )}
    </fieldset>
  );
}

/**
 * Custom bounds for a date range filter, beside its presets. The value is
 * the filter's `from..to` bounds, so a relative bound survives the URL, a
 * saved view and an edit as its token.
 */
export function DateRangeBounds({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const bounds = value === undefined ? undefined : parseRangeBounds(value);
  const [from, setFrom] = useState(bounds?.from);
  const [to, setTo] = useState(bounds?.to);
  const update = (nextFrom: string | undefined, nextTo: string | undefined) => {
    setFrom(nextFrom);
    setTo(nextTo);
    onChange(formatRangeBounds(nextFrom, nextTo));
  };
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <DateBound
        label="From"
        bound={from}
        onChange={(next) => update(next, to)}
      />
      <DateBound
        label="To"
        bound={to}
        onChange={(next) => update(from, next)}
      />
    </div>
  );
}
