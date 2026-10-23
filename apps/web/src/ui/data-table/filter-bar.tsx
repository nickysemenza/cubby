import "./table.css";
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
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { HashIcon } from "@phosphor-icons/react/dist/csr/Hash";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TextTIcon } from "@phosphor-icons/react/dist/csr/TextT";
import { ToggleLeftIcon } from "@phosphor-icons/react/dist/csr/ToggleLeft";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { RowData } from "@tanstack/react-table";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  type RefObject,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { householdLocalDate } from "~/lib/household-date";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import { pickerOptionItem } from "~/ui/combobox/picker-option";
import { PickerVisual } from "~/ui/combobox/picker-visual";
import { RecordPill } from "~/ui/common/record-pill";
import { focusOnMount } from "~/ui/hooks/focus-on-mount";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import { EnumPill } from "~/ui/primitives/enum-pill";
import { Input } from "~/ui/primitives/input";
import { Pill } from "~/ui/primitives/pill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import { Switch } from "~/ui/primitives/switch";

import {
  activeSides,
  type Filter,
  type FilterBarField,
  type FilterSide,
  type FilterValueType,
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

/** A declared field is "active" (shows a chip, counts toward Clear) once its filter has a real value. */
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

const labelOf = (field: FilterBarField) => field.label ?? field.key;

/**
 * An active filter's value text; empty while inactive, so a row or chip
 * never shows a value it does not hold. An active Any value reads "has a
 * value"; picked values join with "or", or "and" under Match all; excluded
 * values read "is not …". Without a `side` the text covers both sides.
 */
export function filterSummary(
  field: FilterBarField,
  filter: Filter | undefined,
  side?: FilterSide,
  joiner?: string,
): string {
  if (filter === undefined || !isFieldActive(filter)) return "";
  if (field.type === "text") return filter.values[0] ?? "";
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
    .join(joiner ?? " or ");
  const isNot = excluded ? `is not ${excluded}` : "";
  if (side === "isNot") return isNot;
  const included = sideValues(filter.values, "is");
  const picked = included
    .filter((value) => value !== FILTER_NONE && value !== FILTER_ANY)
    .map((value) => labels.get(value) ?? value)
    .join(joiner ?? (filter.values.includes(FILTER_ALL) ? " and " : " or "));
  const is = included.includes(FILTER_ANY)
    ? "has a value"
    : !included.includes(FILTER_NONE)
      ? picked
      : picked
        ? `${picked} or no value`
        : "no value";
  if (side === "is") return is;
  return [is, isNot].filter(Boolean).join(" · ");
}

/**
 * A chip's operator between its field and values: "is any of" for several
 * picked values, "contains" for text. Bounds and the Any/No value
 * predicates already read as a phrase, so they take none.
 */
function chipOperator(
  field: FilterBarField,
  filter: Filter | undefined,
  side: FilterSide,
): string {
  if (side === "isNot" || !filter) return "";
  if (field.type === "text") return "contains";
  if (field.valueType === "date" || field.valueType === "number") return "";
  const included = sideValues(filter.values, "is");
  if (included.includes(FILTER_ANY) || included.includes(FILTER_NONE))
    return "";
  if (field.type !== "multiselect" || included.length < 2) return "is";
  return filter.values.includes(FILTER_ALL) ? "is all of" : "is any of";
}

/** The type glyph a Filters panel row leads with. */
function FilterTypeGlyph({ field }: { field: FilterBarField }) {
  const type: FilterValueType = field.valueType ?? "enum";
  if (type === "entity" && field.icon)
    return (
      <span aria-hidden className="flex size-3.5 items-center justify-center">
        {field.icon}
      </span>
    );
  const Glyph = {
    text: TextTIcon,
    enum: ListChecksIcon,
    entity: LinkSimpleIcon,
    date: CalendarBlankIcon,
    number: HashIcon,
    boolean: ToggleLeftIcon,
    presence: ToggleLeftIcon,
  }[type];
  return <Glyph aria-hidden className="size-3.5" />;
}

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
  const daysHintId = useId();
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
              aria-describedby={daysHintId}
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
            <p id={daysHintId} className="px-1 text-xs text-destructive">
              Enter whole days, up to{" "}
              {RELATIVE_DATE_MAX_DAYS.toLocaleString("en-US")}.
            </p>
          ) : (
            <p id={daysHintId} className="px-1 text-xs text-muted-foreground">
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
  const hintId = useId();
  const hint = invalid ? numberBoundError(range) : description;
  return (
    <div className="flex flex-col gap-1">
      {/* Text, not `type="number"`: a number input reports incomplete text
          (`-`, `1e`) as empty, which would read as clearing the bound. */}
      <Input
        inputMode={range.int ? "numeric" : "decimal"}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? hintId : undefined}
        className="tabular-nums"
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        id={hintId}
        className={cn(
          "px-1 text-xs",
          invalid ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {hint}
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
    // With nothing outstanding, the current value is never echoed back, so
    // it is not queued; behind outstanding emissions its echo still comes.
    if (next !== seen || pending.length > 0)
      setPending((queue) => [...queue, next]);
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

/** Any | Yes | No: a boolean or presence filter holds one value or none. */
const ANY_SEGMENT = "*any";

const isTriState = (field: FilterBarField): boolean =>
  (field.valueType === "boolean" || field.valueType === "presence") &&
  field.type === "select" &&
  (field.options ?? []).filter((option) => !option.meta).length === 2;

function TriStateEditor({ field, filter, setValues, clear }: FieldEditorProps) {
  const choices = (field.options ?? [])
    .filter((option) => !option.meta)
    .map(({ value, label }) => ({ value, label }));
  const value = filter?.values[0];
  return (
    <Picker
      mode="segmented"
      label={`Filter ${labelOf(field)}`}
      options={[{ value: ANY_SEGMENT, label: "Any" }, ...choices]}
      value={
        value !== undefined && choices.some((choice) => choice.value === value)
          ? value
          : ANY_SEGMENT
      }
      onValueChange={(next) => {
        if (next === null || next === ANY_SEGMENT) clear();
        else setValues([next]);
      }}
    />
  );
}

/**
 * A value list edited in place: the inline Picker's checklist, each pick
 * written as it is made. Any value / No value lead the roster above its
 * divider; a multi-valued field adds Match any | Match all, an excludable one
 * is | is not, a hierarchical reference its "Include sub-…" switch.
 */
function ChecklistEditor({
  field,
  filter,
  side: initialSide = "is",
  setValues,
}: FieldEditorProps) {
  const [side, setSide] = useState<FilterSide>(initialSide);
  const values = filter?.values ?? [];
  const roster = visibleOptions(field, filter);
  // Any value / No value belong to the "is" side.
  const isNotRoster = useMemo(
    () =>
      roster.filter(
        (option) => option.value !== FILTER_ANY && option.value !== FILTER_NONE,
      ),
    [roster],
  );
  const label = labelOf(field);
  useEffect(() => {
    field.onActivate?.(selectedValues(filter?.values ?? []));
  }, [field, filter?.values]);
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
            value={values.includes(FILTER_ALL) ? "all" : "any"}
            onValueChange={(value) => {
              if (value)
                setValues(withMode(values, FILTER_ALL, value === "all"));
            }}
          />
        )}
        {field.subtree && (
          <label className="flex items-center justify-between gap-3 px-1 text-xs">
            {field.subtree.label}
            <Switch
              checked={!values.includes(FILTER_EXACT)}
              onCheckedChange={(checked: boolean) =>
                setValues(withMode(values, FILTER_EXACT, !checked))
              }
            />
          </label>
        )}
      </>
    ) : undefined;
  return (
    <Picker
      presentation="inline"
      multiple
      checklist
      label={`Filter ${label}`}
      options={side === "is" ? roster : isNotRoster}
      values={sideValues(values, side)}
      onValuesChange={(picked) =>
        setValues(withSideValues(values, side, picked))
      }
      onSearchChange={field.onSearchChange}
      isLoading={field.isLoading}
      records={field.records}
      header={header}
      renderItem={
        field.referenceEntity || roster.some((option) => option.glyph)
          ? (item) => {
              const option = roster.find(
                (candidate) => candidate.value === item.id,
              );
              return (
                <span className="flex min-w-0 items-center justify-between gap-2">
                  {field.referenceEntity &&
                  !option?.meta &&
                  !item.presentation?.meta ? (
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <RecordPill
                        name={item.presentation?.rowLabel ?? item.name}
                        mark={<PickerVisual item={item} size={18} />}
                      />
                      {(item.detail || item.secondary) && (
                        <span className="text-xs text-muted-foreground">
                          {[item.detail, item.secondary]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                  ) : option?.glyph ? (
                    <EnumPill
                      optionRole={option.role}
                      value={option.value}
                      glyph={option.glyph}
                      color={option.color}
                      className="text-pill h-4.5"
                    >
                      {option.label}
                    </EnumPill>
                  ) : (
                    <span>{item.name}</span>
                  )}
                  {option?.hint && (
                    <span className="text-pill font-mono text-muted-foreground">
                      {option.hint}
                    </span>
                  )}
                </span>
              );
            }
          : undefined
      }
    />
  );
}

/** "In this list: 3 to 48", from the range facet under the other filters. */
function BoundsHint({ field }: { field: FilterBarField }) {
  const { min, max } = field.bounds ?? { min: null, max: null };
  if (min === null && max === null) return null;
  return (
    <p className="px-1 text-xs text-muted-foreground tabular-nums">
      In this list: {min ?? "…"} to {max ?? "…"}
    </p>
  );
}

/** One value (a preset, a single reference) picked from the inline list. */
function SingleValueEditor({
  field,
  filter,
  setValues,
  clear,
}: FieldEditorProps) {
  const value = filter?.values[0];
  const isBounds =
    (field.dateRange === true || field.numberRange !== undefined) &&
    value !== undefined &&
    parseRangeBounds(value) !== undefined;
  useEffect(() => {
    field.onActivate?.(selectedValues(filter?.values ?? []));
  }, [field, filter?.values]);
  return (
    <Picker
      presentation="inline"
      options={visibleOptions(field, filter)}
      value={isBounds ? null : (value ?? null)}
      onValueChange={(next) => (next === null ? clear() : setValues([next]))}
      label={`Filter ${labelOf(field)}`}
      onSearchChange={field.onSearchChange}
      isLoading={field.isLoading}
      records={field.records}
    />
  );
}

interface FieldEditorProps {
  field: FilterBarField;
  filter: Filter | undefined;
  /** The side a chip opens on; a checklist can switch it. */
  side?: FilterSide;
  setValues: (values: string[]) => void;
  clear: () => void;
}

/** The editor for one field, shaped by what its values are; every edit applies. */
function FieldValueEditor(props: FieldEditorProps) {
  const { field, filter, setValues } = props;
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
        aria-label={`Filter ${labelOf(field)}`}
        className="h-7 text-xs"
      />
    );
  }
  if (field.type === "multiselect" && field.freeText)
    return (
      <TypedValuesEditor field={field} filter={filter} setValues={setValues} />
    );
  if (field.type === "multiselect") return <ChecklistEditor {...props} />;
  if (isTriState(field)) return <TriStateEditor {...props} />;
  const value = filter?.values[0];
  const hasPresets = visibleOptions(field, filter).length > 0;
  if (field.numberRange)
    return (
      <>
        {hasPresets && <SingleValueEditor {...props} />}
        <NumberRangeBounds
          label={labelOf(field)}
          range={field.numberRange}
          value={value}
          separated={hasPresets}
          onChange={(next) => setValues(next === undefined ? [] : [next])}
        />
        <BoundsHint field={field} />
      </>
    );
  if (field.dateRange)
    return (
      <>
        {hasPresets && <SingleValueEditor {...props} />}
        <DateRangeBounds
          value={value}
          onChange={(next) => setValues(next === undefined ? [] : [next])}
        />
        <BoundsHint field={field} />
      </>
    );
  return <SingleValueEditor {...props} />;
}

function FilterFieldEditor(props: FieldEditorProps) {
  if (props.field.unsupportedReason)
    return (
      <p className="text-xs text-muted-foreground">
        {props.field.unsupportedReason}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <FieldValueEditor {...props} />
      {props.field.description && (
        <p className="px-1 text-xs text-muted-foreground">
          {props.field.description}
        </p>
      )}
    </div>
  );
}

/** What the list shows under the current filters, for the panel footer and strip. */
export interface FilterResultCount {
  /** Rows matching every filter. */
  matching?: number;
  /** Rows with no filter applied. */
  total?: number;
  /** The plural noun the counts name ("accounts"). */
  noun?: string;
}

const resultLine = ({ matching, total, noun }: FilterResultCount) =>
  matching === undefined
    ? null
    : total === undefined || total === matching
      ? `${formatCount(matching)}${noun ? ` ${noun}` : ""}`
      : `${formatCount(matching)} of ${formatCount(total)}${noun ? ` ${noun}` : ""}`;

/**
 * Panel sections in first-appearance order, the active fields lifted out.
 * The open row keeps the section it opened in: moving it mid-edit would
 * remount its editor under the cursor.
 */
function panelSections(
  fields: readonly FilterBarField[],
  filtersByField: ReadonlyMap<string, Filter>,
  open: { key: string; active: boolean } | null,
) {
  const active: FilterBarField[] = [];
  const groups = new Map<string, FilterBarField[]>();
  for (const field of fields) {
    const isActive =
      field.key === open?.key
        ? open.active
        : isFieldActive(filtersByField.get(field.key));
    if (isActive) {
      active.push(field);
      continue;
    }
    const group = field.group ?? "Other";
    groups.set(group, [...(groups.get(group) ?? []), field]);
  }
  return { active, groups: [...groups] };
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col border-t border-hairline-soft py-1 first:border-t-0">
      <h3 className="text-pill px-2 pt-1 pb-1.5 font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One field in the panel: type glyph, label, and its value only while
 * active. Clicking expands its editor in place, one row at a time.
 */
function filterTypeLabel(field: FilterBarField): string {
  if (field.dateRange) return "date range";
  if (field.numberRange) return "number range";
  return {
    entity: "record",
    enum: "choice",
    boolean: "yes / no",
    presence: "yes / no",
    date: "date",
    number: "number",
    text: "text",
  }[field.valueType ?? "enum"];
}

function FilterMark({
  field,
  filter,
  side = "is",
}: {
  field: FilterBarField;
  filter?: Filter;
  side?: FilterSide;
}) {
  const picked = sideValues(filter?.values ?? [], side);
  const option = field.options?.find(
    (candidate) => picked.includes(candidate.value) && !candidate.meta,
  );
  if (option?.color)
    return (
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: option.color }}
      />
    );
  if (option && (option.icon || option.color || option.glyph))
    return <PickerVisual item={pickerOptionItem(option)} size={16} />;
  return (
    <span className="flex size-3 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3">
      <FilterTypeGlyph field={field} />
    </span>
  );
}

function PanelRow({
  field,
  filter,
  open,
  onToggle,
  children,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const label = labelOf(field);
  const summary = filterSummary(field, filter);
  const editorId = useId();
  const triState = isTriState(field);
  if (field.unsupportedReason)
    return (
      <div
        aria-disabled="true"
        className="px-2 py-1 text-sm text-muted-foreground"
      >
        <span>{label}</span>
        <p className="text-xs">{field.unsupportedReason}</p>
      </div>
    );
  const Label = triState ? "span" : "button";
  return (
    <div className={cn("rounded-sm", open && "bg-muted/60")}>
      <div className="flex min-h-6.5 items-center gap-2 rounded-sm px-2 hover:bg-muted max-sm:min-h-11">
        <span className="flex size-4.5 shrink-0 items-center justify-center rounded-[4px] bg-muted text-muted-foreground [&_svg]:size-3">
          <FilterTypeGlyph field={field} />
        </span>
        <Label
          type={triState ? undefined : "button"}
          aria-expanded={triState ? undefined : open}
          aria-controls={open && !triState ? editorId : undefined}
          aria-label={summary ? `${label}: ${summary}` : label}
          title={summary ? `${label}: ${summary}` : undefined}
          className="flex min-h-6.5 min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"
          onClick={triState ? undefined : onToggle}
        >
          <span className={cn("shrink-0", summary && "font-medium")}>
            {label}
          </span>
          {!triState &&
            (summary ? (
              <span className="ml-auto flex min-w-0 items-center gap-1 font-medium">
                <FilterMark field={field} filter={filter} />
                <span className="truncate">{summary}</span>
              </span>
            ) : (
              <span className="ml-auto shrink-0 rounded-[4px] border border-border px-1 text-2xs leading-4 text-muted-foreground">
                {filterTypeLabel(field)}
              </span>
            ))}
        </Label>
        {triState && <div className="ml-auto">{children}</div>}
      </div>
      {open && !triState ? (
        <div id={editorId} className="pt-1 pr-2 pb-2 pl-6.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Filters panel: every declared filter, searchable, the active ones
 * first and the rest grouped by their edit section. Rows expand their editor
 * in place and every edit applies as it is made; the footer reports the
 * live result count.
 */
function FiltersPanel({
  filters,
  fields,
  onChange,
  searchKey,
  initialKey = null,
  initialSide = "is",
  onEditorChange,
  resultCount,
}: FilterEditsArgs & {
  /** A field whose editor starts open (a header's Filter). */
  initialKey?: string | null;
  initialSide?: FilterSide;
  /** Which editor is open, so its owner can load that field's facets. */
  onEditorChange?: (key: string | null) => void;
  resultCount?: FilterResultCount;
}) {
  const [query, setQuery] = useState("");
  const { filtersByField, chipFields, setValues, clear } = useFilterEdits({
    filters,
    fields,
    onChange,
    searchKey,
  });
  const placed = (key: string | null) =>
    key === null
      ? null
      : { key, active: isFieldActive(filtersByField.get(key)) };
  const [open, setOpen] = useState(() => placed(initialKey));
  const openKey = open?.key ?? null;
  useEffect(() => {
    onEditorChange?.(openKey);
    return () => onEditorChange?.(null);
  }, [onEditorChange, openKey]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = chipFields.filter((field) =>
    labelOf(field).toLocaleLowerCase().includes(needle),
  );
  const { active, groups } = panelSections(matches, filtersByField, open);
  const activeCount = chipFields.filter((field) =>
    isFieldActive(filtersByField.get(field.key)),
  ).length;
  const row = (field: FilterBarField) => (
    <PanelRow
      key={field.key}
      field={field}
      filter={filtersByField.get(field.key)}
      open={openKey === field.key}
      onToggle={() => setOpen(placed(openKey === field.key ? null : field.key))}
    >
      <FilterFieldEditor
        field={field}
        filter={filtersByField.get(field.key)}
        side={field.key === initialKey ? initialSide : "is"}
        setValues={(values) => setValues(field, values)}
        clear={() => clear(field)}
      />
    </PanelRow>
  );
  const focusedField = chipFields.find((field) => field.key === openKey);
  const counted = resultCount ? resultLine(resultCount) : null;
  return (
    <div className="flex max-h-[min(36rem,var(--available-height,36rem))] min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline-soft px-3 pt-2.5 pb-2">
        <h2 className="shrink-0 text-sm font-semibold">Filters</h2>
        <div className="relative flex min-w-0 flex-1 items-center">
          <MagnifyingGlassIcon
            aria-hidden
            className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
          />
          <Input
            ref={focusOnMount}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(null);
            }}
            placeholder="Find a filter"
            aria-label="Find a filter"
            className="h-6 pl-7 text-xs"
          />
        </div>
        {activeCount > 0 && (
          <button
            type="button"
            className="shrink-0 text-xs text-info hover:underline"
            onClick={() => onChange([])}
          >
            Clear all
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-0.5">
        {focusedField ? (
          <section
            aria-label={`Filter ${labelOf(focusedField)}`}
            className="px-2 py-2"
          >
            <button
              type="button"
              className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setOpen(null)}
            >
              <ArrowLeftIcon aria-hidden className="size-3" />
              All filters
            </button>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{labelOf(focusedField)}</h3>
              {isFieldActive(filtersByField.get(focusedField.key)) && (
                <button
                  type="button"
                  className="text-xs text-info hover:underline"
                  onClick={() => clear(focusedField)}
                >
                  Clear
                </button>
              )}
            </div>
            <FilterFieldEditor
              key={focusedField.key}
              field={focusedField}
              filter={filtersByField.get(focusedField.key)}
              side={focusedField.key === initialKey ? initialSide : "is"}
              setValues={(values) => setValues(focusedField, values)}
              clear={() => clear(focusedField)}
            />
          </section>
        ) : (
          <>
            {active.length > 0 && (
              <PanelSection title={`Active · ${active.length}`}>
                {active.map(row)}
              </PanelSection>
            )}
            {groups.map(([group, members]) => (
              <PanelSection key={group} title={group}>
                {members.map(row)}
              </PanelSection>
            ))}
            {matches.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No filter matches “{query.trim()}”.
              </p>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="tabular-nums" aria-live="polite">
          <strong className="font-semibold text-foreground">
            {activeCount === 1 ? "1 filter" : `${activeCount} filters`}
          </strong>
          {counted ? ` · ${counted}` : ""}
        </span>
        <span>live</span>
      </div>
    </div>
  );
}

/**
 * One active filter: "Field · is any of · values", with its own ×. The chip
 * opens that field's editor alone; an excluded side gets its own chip.
 */
function FilterChip({
  field,
  filter,
  side,
  open,
  onOpenChange,
  setValues,
  clear,
  editor,
}: {
  editor: ReactNode;
  field: FilterBarField;
  /** Absent while its open editor has emptied it; the chip stays until closed. */
  filter: Filter | undefined;
  side: FilterSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setValues: (values: string[]) => void;
  clear: () => void;
}) {
  const label = labelOf(field);
  const summary = filterSummary(field, filter, side);
  const values = filterSummary(field, filter, side, ", ");
  const operator = chipOperator(field, filter, side);
  const name = summary ? `${label}: ${summary}` : label;
  const clearSide = () => {
    const rest = withSideValues(filter?.values ?? [], side, []);
    if (field.type === "multiselect" && activeSides(rest).length)
      setValues(rest);
    else clear();
  };
  return (
    <span className="text-pill inline-flex h-5 max-w-80 min-w-0 shrink-0 items-center rounded-[var(--brand-web-radius-chip)] border border-border bg-card">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={name}
              title={field.unsupportedReason ?? name}
              className="flex h-full min-w-0 items-center gap-1 rounded-l-[var(--brand-web-radius-chip)] pr-1 pl-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <FilterMark field={field} filter={filter} side={side} />
          <span className="shrink-0 font-medium">{label}</span>
          {operator ? (
            <span className="shrink-0 text-muted-foreground">{operator}</span>
          ) : null}
          <span className="min-w-0 truncate">{values}</span>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-(--available-height) w-[28rem] max-w-[calc(100vw-1rem)] p-0"
        >
          {editor}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label={`Clear ${label} filter`}
        className="flex size-4 shrink-0 items-center justify-center border-l border-hairline-soft text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={clearSide}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

/**
 * The active-filter strip directly above the records: one chip per active
 * filter, "+ Filter" into the panel, Clear, and the filtered total. The page
 * strip it renders into carries the totals and suggestion sweep status.
 */
function ActiveFilterChips({
  filters,
  fields,
  onChange,
  searchKey,
  resultCount,
  onEditorChange,
  className,
}: FilterEditsArgs & {
  resultCount?: FilterResultCount;
  onEditorChange?: (key: string | null) => void;
  className?: string;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { filtersByField, chipFields, setValues, clear } = useFilterEdits({
    filters,
    fields,
    onChange,
    searchKey,
  });
  useEffect(() => {
    if (addOpen) return;
    onEditorChange?.(
      editingKey ? editingKey.slice(0, editingKey.lastIndexOf(":")) : null,
    );
  }, [addOpen, editingKey, onEditorChange]);
  const active = chipFields.filter((field) =>
    isFieldActive(filtersByField.get(field.key)),
  );
  // The chip being edited stays while its editor is open, even emptied:
  // unpicking the last value before picking another must not close it.
  const editingSplit = editingKey?.lastIndexOf(":") ?? -1;
  const editingField = editingKey?.slice(0, editingSplit);
  const editingSide: FilterSide =
    editingKey?.slice(editingSplit + 1) === "isNot" ? "isNot" : "is";
  const shown = chipFields.filter(
    (field) =>
      field.key === editingField ||
      isFieldActive(filtersByField.get(field.key)),
  );
  const counted =
    active.length > 0 && resultCount ? resultLine(resultCount) : null;
  // Nothing active: no strip (the toolbar's Filter button is the way in).
  if (shown.length === 0) return null;
  return (
    <div
      data-active-filter-strip=""
      className={cn(
        "flex min-w-0 flex-1 flex-wrap items-center gap-1.5",
        className,
      )}
    >
      {shown.flatMap((field) => {
        const filter = filtersByField.get(field.key);
        const sides = activeSides(filter?.values);
        if (field.key === editingField && !sides.includes(editingSide))
          sides.push(editingSide);
        return sides.map((side) => {
          const key = `${field.key}:${side}`;
          return (
            <FilterChip
              key={key}
              editor={
                <FiltersPanel
                  filters={filters}
                  fields={fields}
                  onChange={onChange}
                  searchKey={searchKey}
                  initialKey={field.key}
                  initialSide={side}
                  onEditorChange={onEditorChange}
                  resultCount={resultCount}
                />
              }
              field={field}
              filter={filter}
              side={side}
              open={editingKey === key}
              onOpenChange={(open) => setEditingKey(open ? key : null)}
              setValues={(values) => setValues(field, values)}
              clear={() => {
                clear(field);
                setEditingKey(null);
              }}
            />
          );
        });
      })}
      {chipFields.length > 0 && (
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Add filter"
                className="text-pill h-5 shrink-0 rounded-[var(--brand-web-radius-chip)] border border-dashed border-border px-1.5 text-muted-foreground"
              />
            }
          >
            <PlusIcon className="size-3" />
            Filter
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[28rem] p-0">
            <FiltersPanel
              filters={filters}
              fields={fields}
              onChange={onChange}
              searchKey={searchKey}
              onEditorChange={onEditorChange}
              resultCount={resultCount}
            />
          </PopoverContent>
        </Popover>
      )}
      {counted ? (
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {counted}
        </span>
      ) : null}
    </div>
  );
}

/** `/` focuses the search when the person is not already typing somewhere. */
function useSlashHotkey(
  input: RefObject<HTMLInputElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [role='combobox']"))
      )
        return;
      const element = input.current;
      // Hidden (the other breakpoint's copy): leave the key alone.
      if (!element || element.getClientRects().length === 0) return;
      event.preventDefault();
      element.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, input]);
}

/** The declared broad-search input: compact with a `/` hotkey on desktop, full-height in the mobile tier. */
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
  const inputRef = useRef<HTMLInputElement>(null);
  useSlashHotkey(inputRef, dense);
  return (
    <div
      className={cn(
        "relative flex items-center",
        dense ? "h-7.5 min-w-40 flex-1" : "h-9 flex-1",
      )}
    >
      <MagnifyingGlassIcon
        className={cn(
          "pointer-events-none absolute text-muted-foreground",
          dense ? "left-2 size-3.5" : "left-2.5 size-4",
        )}
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && dense) event.currentTarget.blur();
        }}
        placeholder={label}
        aria-label={label}
        aria-keyshortcuts={dense ? "/" : undefined}
        className={
          dense ? "h-7.5 pr-7 pl-7 text-sm md:text-sm" : "h-9 pr-3 pl-8"
        }
      />
      {value && onClear ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-1.5 text-muted-foreground hover:text-foreground"
          onClick={onClear}
        >
          <XIcon className="size-3.5" />
        </button>
      ) : dense ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-1.5 flex h-4 min-w-4 items-center justify-center rounded-[3px] border border-border px-1 font-mono text-2xs text-muted-foreground"
        >
          /
        </kbd>
      ) : null}
    </div>
  );
}

/**
 * The desktop query controls: search, `Filter · N` opening the panel, and
 * the active-filter strip — in place, or portaled into the strip above the
 * records when the page provides one (`chipsTarget`).
 */
export function FilterBar({
  filters,
  fields,
  onChange,
  className,
  searchKey,
  searchPlaceholder,
  chipsTarget,
  resultCount,
  onEditorChange,
  editRequest,
}: FilterEditsArgs & {
  className?: string;
  /**
   * Open the panel on one field's editor (a column header's Filter…). A new
   * object reopens even when the key repeats.
   */
  editRequest?: { key: string } | null;
  searchPlaceholder?: string;
  /** The strip above the records; `null` while it mounts, omitted for inline chips. */
  chipsTarget?: HTMLElement | null;
  resultCount?: FilterResultCount;
  /** Which editor is open, so the owner can load its facets. */
  onEditorChange?: (key: string | null) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelKey, setPanelKey] = useState<string | null>(null);
  useEffect(() => {
    if (!editRequest) return;
    setPanelKey(editRequest.key);
    setPanelOpen(true);
  }, [editRequest]);
  const onPanelOpenChange = (open: boolean) => {
    setPanelOpen(open);
    if (!open) setPanelKey(null);
  };
  const {
    filtersByField,
    searchField,
    chipFields,
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
  const activeCount = chipFields.filter((field) =>
    isFieldActive(filtersByField.get(field.key)),
  ).length;
  const chips = (
    <ActiveFilterChips
      filters={filters}
      fields={fields}
      onChange={onChange}
      searchKey={searchKey}
      resultCount={resultCount}
      onEditorChange={onEditorChange}
      className={chipsTarget ? "max-md:hidden" : undefined}
    />
  );
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
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
      {chipFields.length > 0 && (
        <Popover open={panelOpen} onOpenChange={onPanelOpenChange}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Filters"
                className="h-7.5 shrink-0 gap-1.5 text-sm"
              />
            }
          >
            <FunnelIcon className="size-3.5" />
            Filter
            {activeCount > 0 && (
              <span className="flex size-4 items-center justify-center rounded-full bg-foreground font-mono text-2xs font-medium text-background tabular-nums">
                {activeCount}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[28rem] p-0">
            <FiltersPanel
              key={panelKey ?? ""}
              filters={filters}
              fields={fields}
              onChange={onChange}
              searchKey={searchKey}
              initialKey={panelKey}
              onEditorChange={onEditorChange}
              resultCount={resultCount}
            />
          </PopoverContent>
        </Popover>
      )}
      {chipsTarget === undefined
        ? chips
        : chipsTarget
          ? createPortal(chips, chipsTarget)
          : null}
    </div>
  );
}

/** Filter-list edits shared by the desktop bar and the phone filter tier. */
interface FilterEditsArgs {
  filters: Filter[];
  fields: FilterBarField[];
  onChange: (filters: Filter[]) => void;
  /** The declared broad search field, rendered as an input rather than a filter row. */
  searchKey?: string | undefined;
}

function useFilterEdits({
  filters,
  fields,
  onChange,
  searchKey,
}: FilterEditsArgs) {
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
                  <FilterMark field={field} filter={filter} />
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
          <FilterFieldEditor
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
                  disabled={Boolean(field.unsupportedReason)}
                  onClick={() => setView(field.key)}
                >
                  <span className="font-medium">
                    {field.label ?? field.key}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {field.unsupportedReason ?? filterSummary(field, filter)}
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
