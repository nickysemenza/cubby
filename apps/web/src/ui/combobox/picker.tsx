import {
  Combobox as ComboboxPrimitive,
  Select as SelectPrimitive,
} from "@base-ui/react";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { parseShortcode } from "@cubby/shared";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useDebouncedValue } from "@tanstack/react-pacer";
import * as React from "react";

import { entityLabel } from "~/entity/entities";
import { cn } from "~/lib/utils";
import { useHydrationGate } from "~/ui/hooks/use-hydrated";
import { Spinner } from "~/ui/primitives/spinner";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";

import type {
  ComboboxItem,
  PickerChip,
  PickerEntity,
  PickerTone,
} from "./combobox-types";
import { type PickerOption, pickerOptionItem } from "./picker-option";
import { PickerVisual } from "./picker-visual";
import { useSelectedPickerItems } from "./selected-items";

export function matchesPickerItem(
  item: ComboboxItem,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    item.name,
    item.shortcode,
    item.secondary,
    item.detail,
    ...(item.presentation?.trailing ?? []).map((chip) => chip.text),
    ...(item.aliases ?? []),
  ]
    .filter((part): part is string => !!part)
    .some((part) => part.toLocaleLowerCase().includes(query));
}

interface PickerCommonProps<TId extends string> {
  inputId?: string;
  /** Receives the focusable control (the search input, the choose-mode
   * trigger, or the first segment) so a form can focus it on an error. */
  inputRef?: (element: HTMLElement | null) => void;
  "aria-describedby"?: string;
  entity?: PickerEntity;
  /**
   * Accessible name (falls back to the entity's noun). Not used for the
   * placeholder, "Clear …", or "Create …" strings when an entity is given —
   * those name the entity, never a caller's sentence-length caption.
   */
  label?: string;
  /**
   * - `search` (default): a text input that filters the roster or drives
   *   `onSearchChange`, with create — records and long lists.
   * - `choose`: a button opening the list with arrows, Home/End and letter
   *   typeahead, no text entry — a short fixed list.
   * - `segmented`: every option inline as a button group — two to five view
   *   modes or formats where seeing all choices is the point. Single value.
   */
  mode?: "search" | "choose" | "segmented";
  onSearchChange?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
  isLoading?: boolean;
  error?: string | null;
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
  compact?: boolean;
  openOnMount?: boolean;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
  /** Pinned under the list — a multi-value filter's Clear/Apply. */
  footer?: React.ReactNode;
  /** Segmented mode: icon-only segments on phones, labels kept accessible. */
  iconOnlyOnPhone?: boolean;
}

/** A record-valued picker: the value is the whole selected row. */
interface PickerRecordProps<TId extends string> {
  multiple?: false;
  items: ComboboxItem<TId>[];
  value: ComboboxItem<TId> | null;
  setValue: (item: ComboboxItem<TId> | null) => void;
  options?: never;
  onValueChange?: never;
  values?: never;
  setValues?: never;
  onValuesChange?: never;
}

/** A string-valued picker over fixed `PickerOption`s. */
interface PickerOptionProps {
  multiple?: false;
  options: readonly PickerOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  items?: never;
  setValue?: never;
  values?: never;
  setValues?: never;
  onValuesChange?: never;
}

/** Several records; selected rows show as chips in the field. */
interface PickerRecordsProps<TId extends string> {
  multiple: true;
  items: ComboboxItem<TId>[];
  values: ComboboxItem<TId>[];
  setValues: (items: ComboboxItem<TId>[]) => void;
  options?: never;
  value?: never;
  setValue?: never;
  onValueChange?: never;
  onValuesChange?: never;
}

/** Several string options. */
interface PickerOptionsProps {
  multiple: true;
  options: readonly PickerOption[];
  values: readonly string[];
  onValuesChange: (values: string[]) => void;
  items?: never;
  value?: never;
  setValue?: never;
  onValueChange?: never;
  setValues?: never;
}

export type PickerProps<TId extends string = string> = PickerCommonProps<TId> &
  (
    | PickerRecordProps<TId>
    | PickerOptionProps
    | PickerRecordsProps<TId>
    | PickerOptionsProps
  );

/** A record-valued single picker's props — what wrappers that own the
 * roster (search providers, reference pickers) extend. */
export type RecordPickerProps<TId extends string = string> =
  PickerCommonProps<TId> & PickerRecordProps<TId>;

/** Every variant normalized: rows plus the selected rows. */
type ResolvedPickerProps<TId extends string> = PickerCommonProps<TId> & {
  multiple: boolean;
  items: ComboboxItem<TId>[];
  values: ComboboxItem<TId>[];
  setValues: (items: ComboboxItem<TId>[]) => void;
};

/**
 * The one value picker. Records (search, create, relationship context, a
 * picture) and fixed string options (enums, filters, settings, view modes)
 * share its rows, closed display, and popup; `mode` chooses the input
 * contract and `multiple` the value shape. Entity shortcodes stay searchable
 * without ever being displayed or announced.
 */
export function Picker<TId extends string = string>(props: PickerProps<TId>) {
  const resolved = useResolvedPickerProps(props);
  // A picker's `entity` is fixed for its lifetime, so this branch never
  // remounts the control; only record pickers read records.
  return resolved.entity ? (
    <RecordValuePicker {...resolved} />
  ) : (
    <PickerBody {...resolved} />
  );
}

function RecordValuePicker<TId extends string>(
  props: ResolvedPickerProps<TId>,
) {
  return <PickerBody {...props} values={useSelectedValues(props)} />;
}

function PickerBody<TId extends string>(props: ResolvedPickerProps<TId>) {
  if (props.mode === "segmented") return <SegmentedPicker {...props} />;
  if (props.mode === "choose" && !props.multiple)
    return <ChoosePicker {...props} />;
  return <SearchPicker {...props} />;
}

/**
 * Selected records the caller could only name by code (`{ id, name: id }`,
 * an AI seed without a picture) resolve to the record's own row, so the
 * field always shows names and pictures.
 */
function useSelectedValues<TId extends string>({
  entity,
  values,
  items,
}: ResolvedPickerProps<TId>): ComboboxItem<TId>[] {
  const held = React.useMemo(() => [...values, ...items], [values, items]);
  // SAFETY: each resolved row is built for the same id the caller selected.
  return useSelectedPickerItems(
    entity,
    values.map((value) => value.id),
    held,
  ) as ComboboxItem<TId>[];
}

const isOptionProps = <TId extends string>(
  props: PickerProps<TId>,
): props is PickerCommonProps<TId> & (PickerOptionProps | PickerOptionsProps) =>
  props.options !== undefined;

/** A stored option value the roster doesn't offer: an enum value reads as
 * itself; a record code waits for a loading roster and is never displayed. */
function missingOption<TId extends string>(
  value: string,
  isLoading: boolean | undefined,
): ComboboxItem<TId> {
  const code = parseShortcode(value) != null;
  // SAFETY: option rows are keyed by `PickerOption.value` strings, and a
  // string-valued picker is never instantiated with a branded id.
  return (
    !code
      ? { id: value, name: value }
      : isLoading
        ? { id: value, name: "", pending: true }
        : { id: value, name: "Unavailable record" }
  ) as ComboboxItem<TId>;
}

function useResolvedPickerProps<TId extends string>(
  props: PickerProps<TId>,
): ResolvedPickerProps<TId> {
  const options = props.options;
  const optionItems = React.useMemo(
    () => (options ? options.map(pickerOptionItem) : null),
    [options],
  );
  if (!isOptionProps(props)) {
    const {
      items,
      value: _value,
      setValue: _setValue,
      values: _values,
      setValues: _setValues,
      ...common
    } = props;
    if (props.multiple) {
      return {
        ...common,
        multiple: true,
        items,
        values: props.values,
        setValues: props.setValues,
      };
    }
    const setValue = props.setValue;
    return {
      ...common,
      multiple: false,
      items,
      values: props.value ? [props.value] : [],
      setValues: (next) => setValue(next.at(-1) ?? null),
    };
  }
  const {
    options: _options,
    value: _value,
    onValueChange: _onValueChange,
    values: _values,
    onValuesChange: _onValuesChange,
    ...common
  } = props;
  // SAFETY: option rows are keyed by `PickerOption.value` strings, and a
  // string-valued picker is never instantiated with a branded id.
  const rows = (optionItems ?? []) as ComboboxItem<TId>[];
  const rowFor = (value: string) =>
    rows.find((item) => item.id === value) ??
    missingOption<TId>(value, common.isLoading);
  if (props.multiple) {
    const onValuesChange = props.onValuesChange;
    return {
      ...common,
      multiple: true,
      items: rows,
      values: props.values.map(rowFor),
      setValues: (next) => onValuesChange(next.map((item) => item.id)),
    };
  }
  const onValueChange = props.onValueChange;
  return {
    ...common,
    multiple: false,
    items: rows,
    values: props.value == null ? [] : [rowFor(props.value)],
    setValues: (next) => onValueChange(next.at(-1)?.id ?? null),
  };
}

/**
 * The visible caption (e.g. "Location where this happened") is only ever an
 * accessible name. Every string that names the *thing being picked* —
 * placeholder, "Clear …", "Create …", "No … found." — uses the entity's own
 * noun, or a caption like that renders as "Select Location where this
 * happened…". Callers with no entity key keep using `label` as that noun.
 */
function pickerNaming(
  entity: PickerEntity | undefined,
  label: string | undefined,
) {
  const entityName = entity ? entityLabel(entity) : null;
  const entityNoun = entityName?.toLowerCase() ?? null;
  const noun = entityNoun ?? label?.toLowerCase() ?? "item";
  return {
    ariaLabel: label ?? entityName ?? "",
    noun,
    clearLabel: `Clear ${label ?? entityNoun ?? "value"}`,
    placeholderDefault: entityNoun
      ? `Choose ${/^[aeiou]/i.test(entityNoun) ? "an" : "a"} ${entityNoun}…`
      : "Choose…",
  };
}

function selectedLabelOf(value: ComboboxItem | undefined) {
  if (!value || value.pending) return "";
  return value.name;
}

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

const fieldFrameClass = (compact: boolean | undefined) =>
  cn(
    "flex w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-sm border border-border bg-card pl-2 transition-colors",
    "focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/30",
    "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 data-[hydrating]:has-[:disabled]:opacity-100",
    compact
      ? "min-h-7 text-xs/relaxed max-sm:min-h-11 max-sm:text-base"
      : "min-h-8 text-sm max-sm:min-h-11 max-sm:text-base",
  );

/**
 * One width rule: the popup is the field's width; a field narrower than
 * 16rem lets its popup grow to its rows, up to 16rem. Never wider than the
 * viewport allows.
 */
const popupClass = cn(
  "flex max-h-[min(var(--available-height),calc(var(--app-viewport-height,100dvh)_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)_-_1rem),28rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-md border border-[var(--border)] bg-popover text-popover-foreground shadow-[var(--shadow-overlay)] outline-none",
  "w-max max-w-[min(max(var(--anchor-width),16rem),var(--available-width),calc(100vw-16px))] min-w-(--anchor-width)",
  "transition-[opacity,scale] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
);

const listClass =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none";

const rowClass = (meta: boolean, custom: boolean) =>
  cn(
    "relative flex min-h-7 cursor-default items-center gap-2 rounded-sm px-1.5 py-0.5 text-left text-sm outline-none select-none max-sm:min-h-11",
    "data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[selected]:bg-accent/60",
    "data-disabled:cursor-not-allowed data-disabled:text-muted-foreground",
    meta &&
      "min-h-6 font-mono text-2xs tracking-wider text-slate uppercase max-sm:min-h-11",
    custom && "items-start py-1 whitespace-normal",
  );

const chipToneClass = {
  neutral: "bg-muted text-foreground",
  positive: "bg-positive/10 text-positive",
  warning: "bg-warning/15 text-warning-ink",
  destructive: "bg-destructive/10 text-destructive",
} satisfies Record<PickerTone, string>;

function PickerChipView({ chip }: { chip: PickerChip }) {
  return (
    <span
      className={cn(
        "h-5 max-w-full min-w-0 shrink truncate rounded-[3px] px-1.5 font-mono text-xs leading-5 tabular-nums",
        chipToneClass[chip.tone ?? "neutral"],
      )}
    >
      {chip.node ?? chip.text}
    </span>
  );
}

function PickerRowContent<TId extends string>({
  item,
  renderItem,
}: {
  item: ComboboxItem<TId>;
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
}) {
  const presentation = item.presentation;
  if (renderItem)
    return <span className="min-w-0 flex-1">{renderItem(item)}</span>;
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          {/* The name keeps a readable floor; secondary text and chips give
              way first in a narrow popup. */}
          <span className="min-w-[5rem] shrink truncate">
            {presentation?.rowLabel ?? item.name}
          </span>
          {item.secondary ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {item.secondary}
            </span>
          ) : null}
        </span>
        {item.detail ? (
          <span className="truncate text-xs text-muted-foreground">
            {item.detail}
          </span>
        ) : null}
        {presentation?.disabledReason ? (
          <span className="truncate text-xs text-muted-foreground">
            {presentation.disabledReason}
          </span>
        ) : null}
      </span>
      {presentation?.trailing?.length ? (
        <span className="flex max-w-[55%] min-w-0 shrink items-center justify-end gap-1 overflow-hidden">
          {presentation.trailing.map((chip) => (
            <PickerChipView key={chip.text} chip={chip} />
          ))}
        </span>
      ) : null}
    </>
  );
}

/** Accessible row name: everything the row shows, never its shortcode. */
function rowAriaLabel(item: ComboboxItem) {
  const presentation = item.presentation;
  return [
    item.name,
    item.secondary,
    item.detail,
    ...(presentation?.trailing ?? []).map((chip) => chip.text),
    presentation?.disabledReason,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Group headers and the meta/roster divider before a row — shared by both
 * list modes. Callers own ordering; a header renders when the group changes. */
function PickerRowPreamble({
  item,
  previous,
}: {
  item: ComboboxItem;
  previous: ComboboxItem | undefined;
}) {
  const group = item.presentation?.group;
  const showGroup = group && group.id !== previous?.presentation?.group?.id;
  const firstAfterMeta =
    previous?.presentation?.meta === true && !item.presentation?.meta;
  return (
    <>
      {firstAfterMeta || (showGroup && previous) ? (
        <div
          role="presentation"
          className="mx-1.5 my-1 border-t border-border"
        />
      ) : null}
      {showGroup ? (
        <div
          role="presentation"
          className="px-1.5 pt-1 pb-0.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {group.label}
        </div>
      ) : null}
    </>
  );
}

function rowStyle(item: ComboboxItem) {
  const depth = item.presentation?.depth ?? 0;
  return depth > 0 ? { paddingLeft: 6 + depth * 12 } : undefined;
}

function CaretGlyph({ open }: { open: boolean }) {
  return (
    <CaretDownIcon
      aria-hidden
      className={cn(
        "size-3.5 text-muted-foreground transition-transform duration-150",
        open && "rotate-180",
      )}
    />
  );
}

/** The closed field's leading visual, or a spinner while the stored value is
 * still resolving to its record. */
function SelectedLead({ value }: { value: ComboboxItem | undefined }) {
  if (!value) return null;
  if (value.pending) return <Spinner className="size-3.5 shrink-0" />;
  return <PickerVisual item={value} size={20} />;
}

/** The closed field's first data chip, yielding width to the name. */
function SelectedTrailing({ value }: { value: ComboboxItem | undefined }) {
  const chip = value?.pending ? undefined : value?.presentation?.trailing?.[0];
  if (!chip) return null;
  return (
    <span className="max-w-[40%] min-w-0 shrink truncate font-mono text-xs text-muted-foreground tabular-nums max-sm:hidden">
      {chip.node ?? chip.text}
    </span>
  );
}

function sortByGroup<TId extends string>(items: ComboboxItem<TId>[]) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const groupOrderA = a.item.presentation?.group?.order ?? 0;
      const groupOrderB = b.item.presentation?.group?.order ?? 0;
      return groupOrderA - groupOrderB || a.index - b.index;
    })
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// Search mode (single or multiple)
// ---------------------------------------------------------------------------

type CreatePickerItem<TId extends string> = {
  name: string;
  onCreate: (name: string) => Promise<ComboboxItem<TId>>;
};

/** The popup owns result status and the create transition; the input owns focus. */
function SearchPickerPopup<TId extends string>({
  anchorRef,
  orderedItems,
  renderItem,
  clearable,
  hasValue,
  noun,
  clearLabel,
  clear,
  addCreated,
  setQuery,
  changeOpen,
  isLoading,
  error,
  emptyMessage,
  create,
  footer,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  orderedItems: ComboboxItem<TId>[];
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
  clearable?: boolean;
  hasValue: boolean;
  noun: string;
  clearLabel: string;
  clear: () => void;
  addCreated: (item: ComboboxItem<TId>) => void;
  setQuery: (query: string) => void;
  changeOpen: (open: boolean) => void;
  isLoading?: boolean;
  error?: string | null;
  emptyMessage: string;
  create: CreatePickerItem<TId> | null;
  footer?: React.ReactNode;
}) {
  const [isCreating, setIsCreating] = React.useState(false);
  const handleCreate = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!create) return;
    event.preventDefault();
    event.stopPropagation();
    setIsCreating(true);
    changeOpen(false);
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      addCreated(await create.onCreate(create.name));
      setQuery("");
    } catch {
      // SILENT: every `onCreate` implementation (useEntityCommands.create's
      // mutateAsync, or the vendor picker's local echo) already surfaces its
      // own failure toast; this catch only reopens the combobox with the
      // typed name so the person can retry.
      changeOpen(true);
      setQuery(create.name);
    } finally {
      setIsCreating(false);
    }
  };
  const showStatus = isLoading || error;
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side="bottom"
        sideOffset={4}
        align="start"
        collisionPadding={8}
        anchor={anchorRef}
        // Marks the portaled dropdown so cell-editor-overlay's click-outside
        // check (DOM containment) doesn't treat clicks in here as "outside".
        data-combobox-popup=""
        // z-[200]: paints above CellEditorOverlay (z-100).
        className="isolate z-[200]"
      >
        <ComboboxPrimitive.Popup className={popupClass}>
          {clearable && hasValue ? (
            <button
              type="button"
              aria-label={clearLabel}
              className="flex min-h-7 w-full shrink-0 items-center gap-2 border-b border-[var(--border)] px-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground max-sm:min-h-11"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clear();
                setQuery("");
                changeOpen(false);
              }}
            >
              <XIcon className="size-3.5" />
              {clearLabel}
            </button>
          ) : null}
          <ComboboxPrimitive.List className={listClass}>
            {orderedItems.map((item, index) => (
              <React.Fragment key={item.id}>
                <PickerRowPreamble
                  item={item}
                  previous={orderedItems[index - 1]}
                />
                <ComboboxPrimitive.Item
                  value={item}
                  disabled={item.presentation?.disabledReason != null}
                  aria-label={rowAriaLabel(item)}
                  className={rowClass(
                    item.presentation?.meta === true,
                    renderItem != null,
                  )}
                  style={rowStyle(item)}
                >
                  <PickerVisual item={item} size={20} />
                  <PickerRowContent item={item} renderItem={renderItem} />
                  <ComboboxPrimitive.ItemIndicator className="shrink-0">
                    <CheckIcon className="size-3.5" />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              </React.Fragment>
            ))}
          </ComboboxPrimitive.List>
          {showStatus ? (
            <div className="shrink-0 border-t border-[var(--border)] px-2.5 py-2 text-sm">
              {isLoading ? (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Spinner /> Searching…
                </span>
              ) : error ? (
                <span className="text-destructive">{error}</span>
              ) : null}
            </div>
          ) : null}
          {/* The mounted `Combobox.Empty` part registers the popup's empty
              state; a plain element lets Escape close the parent dialog. */}
          <ComboboxPrimitive.Empty>
            {!isLoading && !error ? (
              <div className="shrink-0 border-t border-[var(--border)] px-2.5 py-2 text-sm text-muted-foreground">
                {emptyMessage}
              </div>
            ) : null}
          </ComboboxPrimitive.Empty>
          {create ? (
            <button
              type="button"
              disabled={isCreating}
              className="flex min-h-7 w-full shrink-0 items-center border-t border-[var(--border)] px-2.5 text-left text-sm hover:bg-accent disabled:opacity-50 max-sm:min-h-11"
              onClick={handleCreate}
            >
              {isCreating
                ? `Creating ${noun}…`
                : `Create ${noun}: ${create.name}`}
            </button>
          ) : null}
          {footer ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-1.5 py-1">
              {footer}
            </div>
          ) : null}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

// Base UI synchronizes these functions into its store; rerenders must not
// create new identities and recursively notify its subscribers.
const pickerItemLabel = (item: ComboboxItem) => item.name;
const pickerItemValue = (item: ComboboxItem) => item.id;
const pickerItemsEqual = (item: ComboboxItem, selected: ComboboxItem) =>
  item.id === selected.id;

/** A selected record or option inside a multiple field: Base UI's chip
 * parts, so Backspace in the empty input and arrow keys reach the chips. */
function SelectionChip({ item }: { item: ComboboxItem }) {
  const name = item.pending ? "Loading…" : item.name;
  return (
    <ComboboxPrimitive.Chip className="inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-[3px] bg-muted pr-0.5 pl-1 text-xs outline-none data-highlighted:bg-accent">
      <PickerVisual item={item} size={16} />
      <span className="min-w-0 truncate">{name}</span>
      <ComboboxPrimitive.ChipRemove
        aria-label={`Remove ${item.pending ? "selection" : item.name}`}
        // 16px glyph; a 44px phone target around it.
        className="relative flex size-4 items-center justify-center rounded-[2px] text-muted-foreground hover:bg-background hover:text-foreground max-sm:before:absolute max-sm:before:-inset-[14px] max-sm:before:content-['']"
      >
        <XIcon className="size-3" />
      </ComboboxPrimitive.ChipRemove>
    </ComboboxPrimitive.Chip>
  );
}

/**
 * The input is both the closed display and the open search field, so opening
 * an editor never introduces a second focus target. In `multiple` the input
 * only ever holds the query; selected rows are chips before it.
 */
function SearchPicker<TId extends string>({
  inputId,
  inputRef: fieldRef,
  "aria-describedby": ariaDescribedBy,
  entity,
  label,
  multiple,
  items,
  values,
  setValues,
  onSearchChange,
  onOpenChange,
  onCreateNew,
  isLoading,
  error,
  renderItem,
  compact,
  openOnMount,
  placeholder,
  clearable,
  disabled,
  className,
  footer,
}: ResolvedPickerProps<TId>) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debouncedQuery] = useDebouncedValue(query, { wait: 150 });
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const gate = useHydrationGate(disabled);
  const setInputRef = React.useCallback(
    (input: HTMLInputElement | null) => {
      inputRef.current = input;
      fieldRef?.(input);
    },
    [fieldRef],
  );
  const single = multiple ? undefined : values[0];

  const { ariaLabel, noun, clearLabel, placeholderDefault } = pickerNaming(
    entity,
    label,
  );

  const inputValue = open || multiple ? query : selectedLabelOf(single);

  const visibleItems = React.useMemo(() => {
    const roster = onSearchChange
      ? items
      : items.filter((item) => matchesPickerItem(item, query));
    if (query.trim() !== "") return roster;
    const missing = values.filter(
      (value) => !value.pending && !roster.some((item) => item.id === value.id),
    );
    return missing.length > 0 ? [...missing, ...roster] : roster;
  }, [items, onSearchChange, query, values]);

  const orderedItems = React.useMemo(
    () => sortByGroup(visibleItems),
    [visibleItems],
  );

  React.useEffect(() => {
    if (open) onSearchChange?.(debouncedQuery);
  }, [debouncedQuery, onSearchChange, open]);

  const normalizedQuery = query.trim();
  const exactName = visibleItems.some(
    (item) =>
      item.name.trim().toLocaleLowerCase() ===
      normalizedQuery.toLocaleLowerCase(),
  );
  const parsedCode = parseShortcode(normalizedQuery);
  // The manifest prefix carries its dash ("PRD-").
  const entityPrefix = entity
    ? entityManifest[entity].shortcodePrefix.replace(/-$/u, "")
    : null;
  const wrongPrefix =
    entity != null && parsedCode != null && parsedCode.type !== entity;
  const searchingForCode =
    normalizedQuery !== "" &&
    (parsedCode != null ||
      (entityPrefix != null &&
        normalizedQuery.toUpperCase().startsWith(`${entityPrefix}-`)));
  const searchSettled =
    onSearchChange == null ||
    normalizedQuery.toLocaleLowerCase() ===
      debouncedQuery.trim().toLocaleLowerCase();
  const canCreate =
    onCreateNew != null &&
    normalizedQuery !== "" &&
    !exactName &&
    !searchingForCode &&
    searchSettled &&
    !isLoading;

  const changeOpen = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        setQuery("");
        onSearchChange?.("");
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, onSearchChange],
  );

  // Once per mount: a caller's search callback changes identity as its
  // results load, and re-opening would wipe the query being typed.
  const openedOnMount = React.useRef(false);
  React.useEffect(() => {
    if (!openOnMount || openedOnMount.current) return;
    openedOnMount.current = true;
    changeOpen(true);
  }, [openOnMount, changeOpen]);

  const emptyMessage = wrongPrefix
    ? `${normalizedQuery.toUpperCase()} is not a ${entityPrefix} code.`
    : `No ${noun} found.`;

  const clear = () => setValues([]);
  const addCreated = (item: ComboboxItem<TId>) =>
    setValues(multiple ? [...values, item] : [item]);

  const input = (
    <ComboboxPrimitive.Input
      id={inputId}
      ref={setInputRef}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      placeholder={
        single?.pending
          ? "Loading…"
          : multiple && values.length > 0
            ? undefined
            : (placeholder ?? placeholderDefault)
      }
      className={cn(
        // A floor so a field squeezed into a narrow cell (a recipe
        // ingredient row) keeps its text; the caret and clear give way.
        "h-full min-w-12 flex-1 bg-transparent outline-none placeholder:text-muted-foreground",
        multiple && "min-w-16",
      )}
    />
  );

  const field = (
    <ComboboxPrimitive.InputGroup
      ref={anchorRef}
      data-hydrating={gate["data-hydrating"]}
      className={cn(fieldFrameClass(compact), multiple && "flex-wrap py-0.5")}
    >
      {multiple ? (
        <ComboboxPrimitive.Chips className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {values.map((value) => (
            <SelectionChip key={value.id} item={value} />
          ))}
          {input}
        </ComboboxPrimitive.Chips>
      ) : (
        <>
          {open ? null : <SelectedLead value={single} />}
          {input}
        </>
      )}
      {open || multiple ? null : <SelectedTrailing value={single} />}
      {clearable && values.length > 0 ? (
        <ComboboxPrimitive.Clear
          aria-label={clearLabel}
          // Shrinks away in a squeezed field; the popup keeps its Clear row.
          className="flex h-full min-w-0 shrink items-center justify-center overflow-hidden px-1 text-muted-foreground transition-colors hover:text-foreground max-sm:min-h-11 max-sm:min-w-11"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            clear();
            setQuery("");
          }}
        >
          <XIcon className="size-3.5" />
        </ComboboxPrimitive.Clear>
      ) : null}
      <ComboboxPrimitive.Trigger
        aria-label={`Show ${noun} options`}
        className="flex h-full w-6 min-w-0 shrink items-center justify-center overflow-hidden max-sm:w-11"
      >
        <CaretGlyph open={open} />
      </ComboboxPrimitive.Trigger>
    </ComboboxPrimitive.InputGroup>
  );

  const popup = (
    <SearchPickerPopup
      anchorRef={anchorRef}
      orderedItems={orderedItems}
      renderItem={renderItem}
      clearable={clearable}
      hasValue={values.length > 0}
      noun={noun}
      clearLabel={clearLabel}
      clear={clear}
      addCreated={addCreated}
      setQuery={setQuery}
      changeOpen={changeOpen}
      isLoading={isLoading}
      error={error}
      emptyMessage={emptyMessage}
      create={
        canCreate && onCreateNew
          ? { name: normalizedQuery, onCreate: onCreateNew }
          : null
      }
      footer={footer}
    />
  );

  const shared = {
    items: orderedItems,
    filteredItems: orderedItems,
    filter: null,
    inputValue,
    onInputValueChange: (nextQuery: string) => {
      if (!open && !multiple) return;
      setQuery(nextQuery);
    },
    itemToStringLabel: pickerItemLabel,
    itemToStringValue: pickerItemValue,
    isItemEqualToValue: pickerItemsEqual,
    open,
    onOpenChange: changeOpen,
    openOnInputClick: true,
    modal: false,
    autoHighlight: true,
    disabled: gate.disabled,
  } as const;

  return (
    <div className={cn("w-full min-w-0", className)}>
      {multiple ? (
        <ComboboxPrimitive.Root<ComboboxItem<TId>, true>
          {...shared}
          multiple
          value={values}
          onValueChange={(next) => {
            setValues(next);
            setQuery("");
          }}
        >
          {field}
          {popup}
        </ComboboxPrimitive.Root>
      ) : (
        <ComboboxPrimitive.Root<ComboboxItem<TId>>
          {...shared}
          value={single ?? null}
          onValueChange={(next) => {
            setValues(next ? [next] : []);
            setQuery("");
            changeOpen(false);
          }}
        >
          {field}
          {popup}
        </ComboboxPrimitive.Root>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Choose mode
// ---------------------------------------------------------------------------

/**
 * Base UI `Select`, not a read-only Combobox: Combobox's root `readOnly`
 * blocks selection itself, and its input treats Home/End as caret movement.
 * `Select` gives the native-select keyboard contract — arrows, Home/End,
 * letter typeahead, Enter/Space — with no soft keyboard on a phone.
 */
function ChoosePicker<TId extends string>({
  inputId,
  inputRef,
  "aria-describedby": ariaDescribedBy,
  entity,
  label,
  items,
  values,
  setValues,
  onOpenChange,
  openOnMount,
  renderItem,
  compact,
  placeholder,
  clearable,
  disabled,
  className,
  footer,
}: ResolvedPickerProps<TId>) {
  const [open, setOpen] = React.useState(openOnMount ?? false);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const gate = useHydrationGate(disabled);
  const value = values[0];
  const { ariaLabel, clearLabel, placeholderDefault } = pickerNaming(
    entity,
    label,
  );
  const labels = React.useMemo(
    () => items.map((item) => ({ value: item.id, label: item.name })),
    [items],
  );
  const orderedItems = React.useMemo(() => sortByGroup(items), [items]);

  return (
    <div className={cn("w-full min-w-0", className)}>
      <SelectPrimitive.Root<string>
        items={labels}
        value={value?.id ?? null}
        onValueChange={(id) => {
          const next = items.find((item) => item.id === id);
          setValues(next ? [next] : []);
        }}
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
        modal={false}
        disabled={gate.disabled}
      >
        <div
          ref={anchorRef}
          data-hydrating={gate["data-hydrating"]}
          className={fieldFrameClass(compact)}
        >
          <SelectPrimitive.Trigger
            id={inputId}
            ref={inputRef}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none"
          >
            <SelectedLead value={value} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                (!value || value.pending) && "text-muted-foreground",
              )}
            >
              {value?.pending
                ? "Loading…"
                : value
                  ? selectedLabelOf(value)
                  : (placeholder ?? placeholderDefault)}
            </span>
            <SelectedTrailing value={value} />
            <span className="flex h-full min-w-6 shrink-0 items-center justify-center max-sm:min-w-11">
              <CaretGlyph open={open} />
            </span>
          </SelectPrimitive.Trigger>
          {clearable && value ? (
            <button
              type="button"
              aria-label={clearLabel}
              disabled={gate.disabled}
              className="flex h-full shrink-0 items-center justify-center px-1.5 text-muted-foreground transition-colors hover:text-foreground max-sm:min-h-11 max-sm:min-w-11"
              onClick={() => setValues([])}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Positioner
            side="bottom"
            sideOffset={4}
            align="start"
            collisionPadding={8}
            anchor={anchorRef}
            alignItemWithTrigger={false}
            data-combobox-popup=""
            className="isolate z-[200]"
          >
            <SelectPrimitive.Popup className={popupClass}>
              <SelectPrimitive.List className={listClass}>
                {orderedItems.map((item, index) => (
                  <React.Fragment key={item.id}>
                    <PickerRowPreamble
                      item={item}
                      previous={orderedItems[index - 1]}
                    />
                    <SelectPrimitive.Item
                      value={item.id}
                      label={item.name}
                      disabled={item.presentation?.disabledReason != null}
                      aria-label={rowAriaLabel(item)}
                      className={rowClass(
                        item.presentation?.meta === true,
                        renderItem != null,
                      )}
                      style={rowStyle(item)}
                    >
                      <PickerVisual item={item} size={20} />
                      <PickerRowContent item={item} renderItem={renderItem} />
                      <SelectPrimitive.ItemIndicator className="shrink-0">
                        <CheckIcon className="size-3.5" />
                      </SelectPrimitive.ItemIndicator>
                    </SelectPrimitive.Item>
                  </React.Fragment>
                ))}
              </SelectPrimitive.List>
              {footer ? (
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-1.5 py-1">
                  {footer}
                </div>
              ) : null}
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented mode
// ---------------------------------------------------------------------------

/**
 * Every option inline as one bordered button group — for a handful of view
 * modes or formats where seeing all choices is the point. Arrow keys move
 * between segments; a segment is never deselected.
 */
function SegmentedPicker<TId extends string>({
  inputRef,
  entity,
  label,
  items,
  values,
  setValues,
  iconOnlyOnPhone,
  disabled,
  className,
}: ResolvedPickerProps<TId>) {
  const gate = useHydrationGate(disabled);
  const { ariaLabel } = pickerNaming(entity, label);
  const value = values[0];
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className={cn("w-fit", className)}
      variant="outline"
      size="sm"
      value={value ? [value.id] : []}
      disabled={gate.disabled}
      data-hydrating={gate["data-hydrating"]}
      onValueChange={(ids: string[]) => {
        const next = items.find((item) => item.id === ids[0]);
        if (next) setValues([next]);
      }}
    >
      {items.map((item, index) => (
        <ToggleGroupItem
          key={item.id}
          ref={index === 0 ? inputRef : undefined}
          value={item.id}
          aria-label={rowAriaLabel(item)}
          // Phone touch floor; desktop segments stay compact (DESIGN.md).
          className="min-h-11 min-w-11 gap-1.5 md:min-h-0 md:min-w-0"
        >
          <PickerVisual item={item} size={16} />
          <span
            className={cn(
              iconOnlyOnPhone && (item.icon || item.thumb) && "max-md:sr-only",
            )}
          >
            {item.presentation?.rowLabel ?? item.name}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
