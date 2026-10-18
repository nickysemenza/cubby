import {
  FILTER_ALL,
  FILTER_ANY,
  FILTER_EXACT,
  FILTER_LIST_SEPARATOR,
  FILTER_NONE,
  splitTypedList,
} from "@cubby/schemas/filter-sentinel-fields";
import {
  describeNumberRangeBounds,
  describeRangeBounds,
  describeRelativeDate,
  formatNumberBound,
  formatRangeBounds,
  type NumberRange,
  parseNumberBound,
  parseRangeBounds,
  RELATIVE_DATE_MAX_DAYS,
  relativeDateOffset,
  RELATIVE_DATE_TODAY,
  relativeDateToken,
  UNRESOLVABLE_ENTITY_FILTER,
} from "@cubby/shared";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { RowData } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";

import { householdLocalDate } from "~/lib/household-date";
import { cn } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import { focusOnMount } from "~/ui/hooks/focus-on-mount";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Pill } from "~/ui/primitives/pill";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import { Switch } from "~/ui/primitives/switch";

import {
  activeSides,
  type Filter,
  type FilterBarField,
  type FilterSide,
  hasFilterValue,
  operatorFor,
  selectedValues,
  sideValues,
  withMode,
  withSideValues,
} from "./filter-bar-core";
import { sortableColumns, SortSection } from "./mobile-sort-sheet";
import type { CubbyTable as Table } from "./table-features";
import TableLayoutCustomizer from "./table-layout-customizer";

const EMPTY_FILTER_OPTIONS: NonNullable<FilterBarField["options"]> = [];
const INVALID_FILTER_OPTION: NonNullable<FilterBarField["options"]>[number] = {
  value: UNRESOLVABLE_ENTITY_FILTER,
  label: "Invalid link filter",
  meta: true,
};

/** Chips shown before the rest collapse behind the ghost `More` control. */
// Three declared chips plus the search input fit in one band beside the
// 176px domain rail at 1440; a fourth wraps `More` onto a second line.
const CHIP_CAP = 3;

/** A declared field is "active" (tints its chip, counts toward Clear N) once its filter has a real value. */
function isFieldActive(filter: Filter | undefined): boolean {
  return filter !== undefined && hasFilterValue(filter);
}

function visibleOptions(field: FilterBarField, filter: Filter | undefined) {
  const options = field.options ?? EMPTY_FILTER_OPTIONS;
  return filter?.values.includes(UNRESOLVABLE_ENTITY_FILTER) &&
    !options.some((option) => option.value === UNRESOLVABLE_ENTITY_FILTER)
    ? [INVALID_FILTER_OPTION, ...options]
    : options;
}

/**
 * The chip's value text. "any" is the declared-but-inactive state, per
 * DESIGN.md; an active Any value reads "has a value" so the two never look
 * alike. Picked values join with "or", or "and" under Match all; excluded
 * values read "is not …". Without a `side` the text covers both sides.
 */
export function filterSummary(
  field: FilterBarField,
  filter: Filter | undefined,
  side?: FilterSide,
): string {
  if (filter === undefined || !isFieldActive(filter)) return "any";
  if (field.type === "text") return filter.values[0] ?? "any";
  const bounds = field.dateRange
    ? describeRangeBounds(filter.values[0] ?? "")
    : field.numberRange
      ? describeNumberRangeBounds(filter.values[0] ?? "", field.numberRange)
      : undefined;
  if (bounds !== undefined) return bounds;
  const labels = new Map(
    visibleOptions(field, filter).map((option) => [option.value, option.label]),
  );
  const excluded = sideValues(filter.values, "isNot")
    .map((value) => labels.get(value) ?? value)
    .join(" or ");
  const isNot = excluded ? `is not ${excluded}` : "";
  if (side === "isNot") return isNot || "any";
  const included = sideValues(filter.values, "is");
  const picked = included
    .filter((value) => value !== FILTER_NONE && value !== FILTER_ANY)
    .map((value) => labels.get(value) ?? value)
    .join(filter.values.includes(FILTER_ALL) ? " and " : " or ");
  const is = included.includes(FILTER_ANY)
    ? "has a value"
    : !included.includes(FILTER_NONE)
      ? picked
      : picked
        ? `${picked} or no value`
        : "no value";
  if (side === "is") return is || "any";
  return [is, isNot].filter(Boolean).join(" · ");
}

/**
 * Multiselect editor: the one Picker in `multiple` mode, editing a draft so
 * the table re-queries once, on Apply — Clear and Apply sit in its footer.
 * Any value / No value lead the roster above its divider; a multi-valued
 * field adds Match any | Match all, a hierarchical reference its
 * "Include sub-…" switch.
 */
const MATCH_OPTIONS = [
  { value: "any", label: "Match any" },
  { value: "all", label: "Match all" },
];

/**
 * The is | is not control: which side of the filter the picker edits. Both
 * sides keep their values, so "Clothing" and "not Outerwear" combine. A
 * filter that cannot exclude shows "is not" disabled with its reason.
 */
function SideControl({
  label,
  side,
  reason,
  onSideChange,
}: {
  label: string;
  side: FilterSide;
  reason: string | null;
  onSideChange: (side: FilterSide) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Picker
        mode="segmented"
        label={`${label} is or is not`}
        options={[
          { value: "is", label: "is" },
          {
            value: "isNot",
            label: "is not",
            ...(reason === null ? {} : { disabledReason: reason }),
          },
        ]}
        value={side}
        onValueChange={(value) => {
          if (value === "is" || value === "isNot") onSideChange(value);
        }}
      />
      {reason !== null && (
        <p className="px-1 text-xs text-muted-foreground">{reason}</p>
      )}
    </div>
  );
}

function MultiselectEditor({
  field,
  filter,
  initialSide = "is",
  onApply,
  onClear,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  initialSide?: FilterSide;
  onApply: (values: string[]) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<string[]>(() => filter?.values ?? []);
  const [side, setSide] = useState<FilterSide>(initialSide);
  const roster = visibleOptions(field, filter);
  // Any value / No value belong to the "is" side.
  const isNotRoster = useMemo(
    () =>
      roster.filter(
        (option) => option.value !== FILTER_ANY && option.value !== FILTER_NONE,
      ),
    [roster],
  );
  const options = side === "is" ? roster : isNotRoster;
  const label = field.label ?? field.key;
  useEffect(() => {
    field.onActivate?.(selectedValues(filter?.values ?? []));
  }, [field, filter?.values]);
  // Inside the picker's popup: anything beside it would sit behind the
  // popup's modal focus scope, unreachable while the list is open.
  const header =
    field.matchAll || field.subtree || field.exclude ? (
      <>
        {field.exclude && (
          <SideControl
            label={label}
            side={side}
            reason={field.exclude.reason}
            onSideChange={setSide}
          />
        )}
        {field.matchAll && side === "is" && (
          <Picker
            mode="segmented"
            label={`Match ${label}`}
            options={MATCH_OPTIONS}
            value={draft.includes(FILTER_ALL) ? "all" : "any"}
            onValueChange={(value) => {
              if (value) setDraft(withMode(draft, FILTER_ALL, value === "all"));
            }}
          />
        )}
        {field.subtree && (
          <label className="flex items-center justify-between gap-3 px-1 text-xs">
            {field.subtree.label}
            <Switch
              checked={!draft.includes(FILTER_EXACT)}
              onCheckedChange={(checked: boolean) =>
                setDraft(withMode(draft, FILTER_EXACT, !checked))
              }
            />
          </label>
        )}
      </>
    ) : undefined;
  return (
    <Picker
      multiple
      openOnMount
      label={`Filter ${label}`}
      options={options}
      values={sideValues(draft, side)}
      onValuesChange={(values) => setDraft(withSideValues(draft, side, values))}
      onSearchChange={field.onSearchChange}
      isLoading={field.isLoading}
      header={header}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              // Clear empties this side; the other side's chip stays.
              const rest = withSideValues(draft, side, []);
              if (activeSides(rest).length) onApply(rest);
              else onClear();
            }}
          >
            Clear
          </Button>
          <Button type="button" size="sm" onClick={() => onApply(draft)}>
            Apply
          </Button>
        </>
      }
    />
  );
}

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

/**
 * A relative bound's token. "Ahead" at zero is written `@today+0d`, so the
 * direction survives the URL while the count is still zero.
 */
const relativeBound = (count: number, ahead: boolean): string =>
  ahead && count === 0
    ? `${RELATIVE_DATE_TODAY}+0d`
    : relativeDateToken(ahead ? count : -count);

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
  // Every mode change emits a bound of that mode, so the bound alone says
  // which mode it is — including a bound changed from outside.
  const mode = modeOf(bound);
  const days = bound === undefined ? undefined : relativeDateOffset(bound);
  const relative = days ?? 0;
  const ahead = bound?.startsWith(`${RELATIVE_DATE_TODAY}+`) ?? false;
  // The typed amount, kept while it is not a token's whole day count: past
  // the token's digits it would emit a bound that is not relative, flipping
  // the mode to Date mid-typing. A new bound (its own echo included) resets it.
  const [daysText, setDaysText] = useState(() => String(Math.abs(relative)));
  const [seenBound, setSeenBound] = useState(bound);
  if (bound !== seenBound) {
    setSeenBound(bound);
    setDaysText(String(Math.abs(relative)));
  }
  const daysInvalid =
    daysText !== "" &&
    !(/^\d+$/.test(daysText) && Number(daysText) <= RELATIVE_DATE_MAX_DAYS);
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
          // Date starts on the household's today, as the Apple editor does,
          // so switching never drops the bound while a day is being picked.
          onChange(
            next === "any"
              ? undefined
              : next === "relative"
                ? relativeDateToken(0)
                : householdLocalDate(),
          );
        }}
      />
      {mode === "date" && (
        <Input
          type="date"
          aria-label={`${label} date`}
          value={bound !== undefined && days === undefined ? bound : ""}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value);
          }}
        />
      )}
      {mode === "relative" && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Input
              inputMode="numeric"
              aria-label={`${label} days`}
              aria-invalid={daysInvalid || undefined}
              className="w-20 tabular-nums"
              value={daysText}
              onChange={(event) => {
                const text = event.target.value.trim();
                setDaysText(text);
                if (!/^\d+$/.test(text)) return;
                const count = Number(text);
                if (count > RELATIVE_DATE_MAX_DAYS) return;
                onChange(relativeBound(count, ahead));
              }}
            />
            <Picker
              options={DIRECTIONS}
              label={`${label} direction`}
              value={ahead ? "future" : "past"}
              onValueChange={(value) =>
                onChange(relativeBound(Math.abs(relative), value === "future"))
              }
              className="flex-1"
            />
          </div>
          {daysInvalid ? (
            <p className="px-1 text-xs text-destructive">
              Enter whole days, up to{" "}
              {RELATIVE_DATE_MAX_DAYS.toLocaleString("en-US")}.
            </p>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              {describeRelativeDate(relative)}, counted from the household's
              today
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Custom bounds for a date range filter, beside its presets. The value is
 * the filter's `from..to` bounds, so a relative bound survives the URL, a
 * saved view and an edit as its token. Every edit is emitted, so the editor
 * holds no draft and follows a value changed from outside (Back/Forward).
 */
function DateRangeBounds({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const bounds = value === undefined ? undefined : parseRangeBounds(value);
  const from = bounds?.from;
  const to = bounds?.to;
  const update = (nextFrom: string | undefined, nextTo: string | undefined) =>
    onChange(formatRangeBounds(nextFrom, nextTo));
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

const numberBoundError = ({ nonnegative, int }: NumberRange): string =>
  `Enter a ${int ? "whole " : ""}number${nonnegative ? " 0 or more" : ""}.`;

/** One side of a number range: typed as is, kept only once it is valid. */
function NumberBound({
  label,
  description,
  range,
  text,
  onChange,
}: {
  label: string;
  description: string | undefined;
  range: NumberRange;
  text: string;
  onChange: (text: string) => void;
}) {
  const invalid =
    text.trim() !== "" && parseNumberBound(text, range) === undefined;
  return (
    <div className="flex flex-col gap-1">
      {/* Text, not `type="number"`: a number input reports incomplete text
          (`-`, `1e`) as empty, which would read as clearing the bound. */}
      <Input
        inputMode={range.int ? "numeric" : "decimal"}
        aria-label={label}
        aria-invalid={invalid || undefined}
        className="tabular-nums"
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        className={cn(
          "px-1 text-xs",
          invalid ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {invalid ? numberBoundError(range) : description}
      </p>
    </div>
  );
}

/**
 * Custom bounds for a number range filter, beside any presets. `value` is
 * the filter's whole value, a preset key or `min..max`; an invalid side
 * (negative under `nonnegative`) shows its error and leaves the filter as it
 * was until it is fixed or emptied.
 */
function NumberRangeBounds({
  label,
  range,
  value,
  separated,
  onChange,
}: {
  label: string;
  range: NumberRange;
  /** Presets sit above, so a rule sets the bounds apart. */
  separated: boolean;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const draftsOf = (bounds: string | undefined) => {
    const parsed = bounds === undefined ? undefined : parseRangeBounds(bounds);
    return { min: parsed?.from ?? "", max: parsed?.to ?? "" };
  };
  const [min, setMin] = useState(() => draftsOf(value).min);
  const [max, setMax] = useState(() => draftsOf(value).max);
  // Emissions the parent has not echoed yet, oldest first. An incoming
  // value among them is an echo, possibly late: it acknowledges that one and
  // every earlier one and leaves the typed text alone. Any other new value
  // (Back/Forward, a preset, Clear) replaces the drafts and the queue. An
  // unchanged value, or an invalid draft that was never emitted, changes
  // nothing.
  const [seen, setSeen] = useState(value);
  const [pending, setPending] = useState<ReadonlyArray<string | undefined>>([]);
  if (value !== seen) {
    setSeen(value);
    const echoed = pending.indexOf(value);
    if (echoed === -1) {
      const drafts = draftsOf(value);
      setPending([]);
      setMin(drafts.min);
      setMax(drafts.max);
    } else setPending(pending.slice(echoed + 1));
  }
  const update = (nextMin: string, nextMax: string) => {
    setMin(nextMin);
    setMax(nextMax);
    const parse = (text: string) =>
      text.trim() === "" ? null : parseNumberBound(text, range);
    const low = parse(nextMin);
    const high = parse(nextMax);
    if (low === undefined || high === undefined) return;
    if (low !== null && high !== null && low > high) return;
    const next = formatRangeBounds(
      low === null ? undefined : formatNumberBound(low),
      high === null ? undefined : formatNumberBound(high),
    );
    // The current value is never echoed back, so it is not queued.
    if (next !== seen) setPending((queue) => [...queue, next]);
    onChange(next);
  };
  const low = parseNumberBound(min, range);
  const high = parseNumberBound(max, range);
  const reversed = low !== undefined && high !== undefined && low > high;
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        separated && "border-t border-border pt-3",
      )}
    >
      <NumberBound
        label={`${label} minimum`}
        description={range.describe?.lower}
        range={range}
        text={min}
        onChange={(next) => update(next, max)}
      />
      <NumberBound
        label={`${label} maximum`}
        description={range.describe?.upper}
        range={range}
        text={max}
        onChange={(next) => update(min, next)}
      />
      {reversed && (
        <p role="alert" className="px-1 text-xs text-destructive">
          The minimum is above the maximum.
        </p>
      )}
    </div>
  );
}

/** The editor body for one field's popover — shape depends on its declared type. */
/**
 * A rosterless multiselect (an external id): values typed comma-separated.
 * The input keeps what was typed (spacing, a trailing comma); the filter
 * holds the values it separates, which the URL codec writes and a reload
 * decodes back unchanged. Excluded values ride along untouched.
 */
function TypedValuesEditor({
  field,
  filter,
  setValues,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  setValues: (values: string[]) => void;
}) {
  const values = sideValues(filter?.values ?? [], "is");
  const key = values.join(FILTER_LIST_SEPARATOR);
  const [draft, setDraft] = useState(() => values.join(", "));
  // A change from outside (reload, Clear, a saved view) replaces the text.
  if (splitTypedList(draft).join(FILTER_LIST_SEPARATOR) !== key)
    setDraft(values.join(", "));
  const label = field.label ?? field.key;
  return (
    <>
      <Input
        ref={focusOnMount}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setValues(
            withSideValues(
              filter?.values ?? [],
              "is",
              splitTypedList(event.target.value),
            ),
          );
        }}
        placeholder={field.placeholder}
        aria-label={`Filter ${label}`}
      />
      <p className="text-xs text-muted-foreground">
        Separate values with commas.
      </p>
    </>
  );
}

function FilterValueEditor({
  field,
  filter,
  side,
  setValues,
  clear,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  /** The side a chip opens on; the editor can switch it. */
  side?: FilterSide;
  setValues: (values: string[]) => void;
  clear: () => void;
}) {
  const options = visibleOptions(field, filter);
  if (field.type === "text") {
    return (
      <Input
        ref={focusOnMount}
        value={filter?.values[0] ?? ""}
        onChange={(event) => setValues([event.target.value])}
        placeholder={field.placeholder}
        type={field.inputType ?? "text"}
        min={field.min}
        max={field.max}
        aria-label={`Filter ${field.label ?? field.key}`}
      />
    );
  }
  if (field.type === "multiselect" && field.freeText) {
    return (
      <TypedValuesEditor field={field} filter={filter} setValues={setValues} />
    );
  }
  if (field.type === "multiselect") {
    return (
      <MultiselectEditor
        field={field}
        filter={filter}
        initialSide={side}
        onApply={setValues}
        onClear={clear}
      />
    );
  }
  const value = filter?.values[0];
  const isBounds =
    (field.dateRange === true || field.numberRange !== undefined) &&
    value !== undefined &&
    parseRangeBounds(value) !== undefined;
  const picker = (
    <Picker
      options={options}
      value={isBounds ? null : (value ?? null)}
      onValueChange={(value) => setValues(value === null ? [] : [value])}
      placeholder={
        isBounds ? "Custom range" : `Filter ${field.label ?? field.key}`
      }
      label={`Filter ${field.label ?? field.key}`}
      clearable
      className="w-full"
      onOpenChange={(open) => {
        if (open) field.onActivate?.(selectedValues(filter?.values ?? []));
      }}
      onSearchChange={field.onSearchChange}
      isLoading={field.isLoading}
    />
  );
  if (field.numberRange) {
    return (
      <>
        {options.length > 0 && picker}
        <NumberRangeBounds
          label={field.label ?? field.key}
          range={field.numberRange}
          value={value}
          separated={options.length > 0}
          onChange={(next) => setValues(next === undefined ? [] : [next])}
        />
      </>
    );
  }
  if (!field.dateRange) return picker;
  return (
    <>
      {options.length > 0 && picker}
      <DateRangeBounds
        value={value}
        onChange={(next) => setValues(next === undefined ? [] : [next])}
      />
    </>
  );
}

function FilterEditor(props: Parameters<typeof FilterValueEditor>[0]) {
  return (
    <div className="flex flex-col gap-2">
      <FilterValueEditor {...props} />
      {props.field.description && (
        <p className="text-xs text-muted-foreground">
          {props.field.description}
        </p>
      )}
    </div>
  );
}

/**
 * One declared-filter chip: `<b>Label</b> value|any`, or `<b>Label</b> is not
 * value` for the excluded side, and opens its editor on that side.
 */
function FilterChip({
  field,
  filter,
  side,
  open,
  onOpenChange,
  setValues,
  clear,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  side: FilterSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setValues: (values: string[]) => void;
  clear: () => void;
}) {
  const label = field.label ?? field.key;
  const summary = filterSummary(field, filter, side);
  const active = activeSides(filter?.values).includes(side);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${summary}`}
            title={`${label}: ${summary}`}
            className={cn(
              "flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 pl-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary",
              active && "border-primary bg-primary/8",
            )}
          />
        }
      >
        <b className="font-medium">{label}</b>
        <span className="min-w-0 truncate text-muted-foreground">
          {summary}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-(--available-height) w-72 overflow-y-auto"
      >
        <PopoverTitle className="font-heading font-bold">
          Filter by {label}
        </PopoverTitle>
        <FilterEditor
          field={field}
          filter={filter}
          side={side}
          setValues={setValues}
          clear={clear}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The declared broad-search input: compact on the desktop bar, full-height in the mobile tier. */
function FilterSearchField({
  dense = false,
  label,
  value,
  onChange,
  onClear,
}: {
  dense?: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Desktop only: renders a clear button while the input has text. */
  onClear?: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center",
        dense ? "h-8 min-w-40 flex-1 md:max-w-sm" : "h-9 flex-1",
      )}
    >
      <MagnifyingGlassIcon
        className={cn(
          "pointer-events-none absolute text-muted-foreground",
          dense ? "left-2 size-3.5" : "left-2.5 size-4",
        )}
      />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        aria-label={label}
        className={dense ? "h-8 pr-6 pl-7 text-xs" : "h-9 pr-3 pl-8"}
      />
      {value && onClear && (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-1.5 text-muted-foreground hover:text-foreground"
          onClick={onClear}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** Filter-list edits shared by the desktop bar and the phone filter tier. */
function useFilterEdits({
  filters,
  fields,
  onChange,
  searchKey,
}: {
  filters: Filter[];
  fields: FilterBarField[];
  onChange: (filters: Filter[]) => void;
  searchKey: string | undefined;
}) {
  const filtersByField = useMemo(
    () => new Map(filters.map((filter) => [filter.field, filter])),
    [filters],
  );
  const searchField = fields.find((field) => field.key === searchKey);
  const chipFields = fields.filter((field) => field.key !== searchKey);
  const activeCount = filters.filter(hasFilterValue).length;

  const setValues = (field: FilterBarField, values: string[]) => {
    const existing = filtersByField.get(field.key);
    // A value in one exclusive scope replaces its group's other scopes.
    const group = field.exclusiveGroup;
    const rest =
      group && values.some((value) => value !== "")
        ? filters.filter(
            (filter) =>
              filter.field === field.key ||
              fields.find((candidate) => candidate.key === filter.field)
                ?.exclusiveGroup !== group,
          )
        : filters;
    if (existing) {
      onChange(
        rest.map((filter) =>
          filter.field === field.key ? { ...filter, values } : filter,
        ),
      );
    } else {
      field.onActivate?.();
      onChange([
        ...rest,
        {
          id: `filter-${field.key}`,
          field: field.key,
          operator: operatorFor(field),
          values,
        },
      ]);
    }
  };
  const clear = (field: FilterBarField) =>
    onChange(filters.filter((filter) => filter.field !== field.key));

  const searchFilter = searchField
    ? filtersByField.get(searchField.key)
    : undefined;
  const searchValue = searchFilter?.values[0] ?? "";

  return {
    filtersByField,
    searchField,
    chipFields,
    activeCount,
    setValues,
    clear,
    searchValue,
  };
}

/**
 * Compact, manifest-backed expression of the table's active query: a search
 * input for the entity's declared primary search, one chip per every other declared
 * field (capped, with the rest behind `More`), and a `Clear N` link.
 *
 * This intentionally supports only the three filter shapes emitted by
 * `barFieldFromConfig`. The old copy-owned ReUI component advertised async
 * loaders, custom renderers, nested groups, arbitrary operators and shortcut
 * handling, none of which Cubby's two production filter bars supplied.
 */
export function FilterBar({
  filters,
  fields,
  onChange,
  className,
  searchKey,
  searchPlaceholder,
  collapsed = false,
}: {
  filters: Filter[];
  fields: FilterBarField[];
  onChange: (filters: Filter[]) => void;
  className?: string;
  /** Page workbenches show active chips and disclose inactive fields. */
  collapsed?: boolean;
  /** The declared broad search field rendered as an input instead of a chip. */
  searchKey?: string;
  searchPlaceholder?: string;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const {
    filtersByField,
    searchField,
    chipFields,
    activeCount,
    setValues,
    clear,
    searchValue,
  } = useFilterEdits({ filters, fields, onChange, searchKey });
  useEffect(() => {
    for (const field of fields) {
      const filter = filtersByField.get(field.key);
      if (filter && isFieldActive(filter))
        field.onActivate?.(selectedValues(filter.values));
    }
  }, [fields, filtersByField]);
  const visibleChipFields = collapsed
    ? chipFields.filter((field) => isFieldActive(filtersByField.get(field.key)))
    : chipFields.slice(0, CHIP_CAP);
  const overflowChipFields = collapsed
    ? chipFields
    : chipFields.slice(CHIP_CAP);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain md:flex-wrap md:overflow-visible",
        className,
      )}
    >
      {searchField && (
        <FilterSearchField
          dense
          label={
            searchPlaceholder ?? `Search ${searchField.label ?? "records"}`
          }
          value={searchValue}
          onChange={(value) => setValues(searchField, [value])}
          onClear={() => clear(searchField)}
        />
      )}

      {visibleChipFields.flatMap((field) => {
        const filter = filtersByField.get(field.key);
        // Each active side gets its own chip; an inactive field shows one.
        const sides = activeSides(filter?.values);
        return (sides.length ? sides : (["is"] as const)).map((side) => {
          const key = `${field.key}:${side}`;
          return (
            <FilterChip
              key={key}
              field={field}
              filter={filter}
              side={side}
              open={editingKey === key && !moreOpen}
              onOpenChange={(open) => setEditingKey(open ? key : null)}
              setValues={(values) => {
                setValues(field, values);
                // Apply commits and closes; a text/combobox editor commits per
                // keystroke and stays open until dismissed.
                if (field.type === "multiselect" && !field.freeText)
                  setEditingKey(null);
              }}
              clear={() => {
                clear(field);
                setEditingKey(null);
              }}
            />
          );
        });
      })}

      {overflowChipFields.length > 0 &&
        (() => {
          const editingOverflow = overflowChipFields.find(
            (field) => field.key === editingKey,
          );
          return (
            <Popover
              open={moreOpen}
              onOpenChange={(open) => {
                setMoreOpen(open);
                if (!open) setEditingKey(null);
              }}
            >
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    aria-label={collapsed ? "Filters" : "More"}
                  />
                }
              >
                {collapsed ? (
                  <FunnelIcon className="size-3.5" />
                ) : (
                  <CaretDownIcon className="size-3.5" />
                )}
                {collapsed ? "Filters" : "More"}
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="max-h-(--available-height) w-72 overflow-y-auto"
              >
                {editingOverflow ? (
                  <>
                    <PopoverTitle className="font-heading font-bold">
                      Filter by {editingOverflow.label ?? editingOverflow.key}
                    </PopoverTitle>
                    <FilterEditor
                      field={editingOverflow}
                      filter={filtersByField.get(editingOverflow.key)}
                      setValues={(values) => setValues(editingOverflow, values)}
                      clear={() => {
                        clear(editingOverflow);
                        setEditingKey(null);
                      }}
                    />
                  </>
                ) : (
                  <>
                    <PopoverTitle className="font-heading font-bold">
                      {collapsed ? "Filters" : "More filters"}
                    </PopoverTitle>
                    <div className="flex flex-col gap-px">
                      {overflowChipFields.map((field) => {
                        const filter = filtersByField.get(field.key);
                        const label = field.label ?? field.key;
                        const summary = filterSummary(field, filter);
                        return (
                          <button
                            key={field.key}
                            type="button"
                            aria-label={`${label}: ${summary}`}
                            className="flex min-h-9 items-center justify-between gap-2 rounded-sm px-2 text-left text-xs hover:bg-muted"
                            onClick={() => setEditingKey(field.key)}
                          >
                            <b className="font-medium">{label}</b>
                            <span className="min-w-0 truncate text-muted-foreground">
                              {summary}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </PopoverContent>
            </Popover>
          );
        })()}

      {activeCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-primary"
          onClick={() => onChange([])}
        >
          Clear {activeCount}
        </Button>
      )}
    </div>
  );
}

/**
 * A list presentation switch (Grouped, Nested) carried into the phone Filter
 * sheet: the same choices desktop offers beside the table.
 */
export interface FilterSheetSwitch {
  id: string;
  label: string;
  active: boolean;
  onChange: (active: boolean) => void;
}

/**
 * The band has no room for presentation icon buttons (seg, search and Filter
 * only), so each switch is a row of the sheet, above Sort.
 */
function SwitchRow({ toggle }: { toggle: FilterSheetSwitch }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={toggle.active}
      className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-1 text-left text-sm"
      onClick={() => toggle.onChange(!toggle.active)}
    >
      <span className="font-medium">{toggle.label}</span>
      {/* The switch's `aria-checked` carries the state for assistive tech. */}
      <span aria-hidden className="text-muted-foreground">
        {toggle.active ? "On" : "Off"}
      </span>
    </button>
  );
}

const NO_SWITCHES: readonly FilterSheetSwitch[] = [];

/**
 * The phone workbench band's query tier: search + a `Filter` button carrying
 * a count badge, then a horizontal strip of only the ACTIVE chips (declared
 * but inactive fields stay inside the sheet — there's no room for an "any"
 * chip row on a 375px band). `Filter` opens one sheet listing every declared
 * field (tap drills into its editor), a `Sort` section, and `Columns` last.
 */
export function MobileFilterTier<TData extends RowData>({
  table,
  filters,
  fields,
  onChange,
  searchKey,
  searchPlaceholder,
  switches = NO_SWITCHES,
}: {
  table: Table<TData>;
  filters: Filter[];
  fields: FilterBarField[];
  onChange: (filters: Filter[]) => void;
  searchKey?: string;
  searchPlaceholder?: string;
  switches?: readonly FilterSheetSwitch[] | undefined;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [view, setView] = useState<"fields" | "columns" | string>("fields");
  const {
    filtersByField,
    searchField,
    chipFields,
    activeCount,
    setValues,
    clear,
    searchValue,
  } = useFilterEdits({ filters, fields, onChange, searchKey });
  const activeChipFields = chipFields.filter((field) =>
    isFieldActive(filtersByField.get(field.key)),
  );
  const editingField = chipFields.find((field) => field.key === view);
  // The `Filter` sheet is also where phone sort lives — surface the trigger
  // for a sortable-only table even when it declares no filterable fields.
  const hasSort = sortableColumns(table).length > 0;
  const showFilterTrigger =
    chipFields.length > 0 || hasSort || switches.length > 0;

  const openSheet = (nextView: typeof view) => {
    setView(nextView);
    setSheetOpen(true);
  };

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex w-full items-center gap-2">
        {searchField && (
          <FilterSearchField
            label={
              searchPlaceholder ?? `Search ${searchField.label ?? "records"}`
            }
            value={searchValue}
            onChange={(value) => setValues(searchField, [value])}
          />
        )}
        {showFilterTrigger && (
          <Button
            type="button"
            variant="outline"
            className="relative h-9 shrink-0"
            onClick={() => openSheet("fields")}
          >
            <FunnelIcon />
            Filter
            {activeCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full bg-primary font-mono text-2xs font-semibold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </Button>
        )}
      </div>

      {activeChipFields.length > 0 && (
        <div className="flex w-full basis-full [scrollbar-width:none] gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {activeChipFields.map((field) => {
            const filter = filtersByField.get(field.key);
            const label = field.label ?? field.key;
            return (
              <Pill
                key={field.key}
                className="h-6 shrink-0 gap-1 border-primary bg-primary/8 px-2 whitespace-nowrap"
              >
                <button
                  type="button"
                  onClick={() => openSheet(field.key)}
                  className="flex items-center gap-1"
                >
                  <b className="font-medium">{label}</b>
                  {filterSummary(field, filter)}
                </button>
                <button
                  type="button"
                  aria-label={`Clear ${label} filter`}
                  onClick={() => clear(field)}
                >
                  <XIcon className="size-3" />
                </button>
              </Pill>
            );
          })}
        </div>
      )}

      <Overlay
        placement="panel"
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={
          editingField
            ? `Filter by ${editingField.label ?? editingField.key}`
            : view === "columns"
              ? "Columns"
              : "Filter"
        }
      >
        {editingField ? (
          <FilterEditor
            field={editingField}
            filter={filtersByField.get(editingField.key)}
            setValues={(values) => {
              setValues(editingField, values);
            }}
            clear={() => {
              clear(editingField);
              setView("fields");
            }}
          />
        ) : view === "columns" ? (
          <TableLayoutCustomizer table={table} />
        ) : (
          <div className="flex flex-col">
            {chipFields.map((field) => {
              const filter = filtersByField.get(field.key);
              return (
                <button
                  key={field.key}
                  type="button"
                  className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-1 text-left text-sm"
                  onClick={() => setView(field.key)}
                >
                  <span className="font-medium">
                    {field.label ?? field.key}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {filterSummary(field, filter)}
                  </span>
                </button>
              );
            })}
            {switches.map((toggle) => (
              <SwitchRow key={toggle.id} toggle={toggle} />
            ))}
            <SortSection table={table} />
            <button
              type="button"
              className="mt-2 flex min-h-11 items-center gap-2 border-t border-border pt-2 text-left text-sm font-medium"
              onClick={() => setView("columns")}
            >
              <GearSixIcon className="size-4" />
              Columns
            </button>
          </div>
        )}
      </Overlay>
    </div>
  );
}
