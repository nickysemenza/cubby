import {
  Combobox as ComboboxPrimitive,
  Select as SelectPrimitive,
} from "@base-ui/react";
import { parseShortcode } from "@cubby/shared";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useDebouncedValue } from "@tanstack/react-pacer";
import * as React from "react";

import { entityLabel } from "~/entity/entities";
import { badgeToneTextClass } from "~/lib/status-tone";
import { cn } from "~/lib/utils";
import { useHydrationGate } from "~/ui/hooks/useHydrated";
import { Spinner } from "~/ui/primitives/spinner";

import type { ComboboxItem, PickerEntity } from "./combobox-types";
import { type PickerOption, pickerOptionItem } from "./picker-option";
import { PickerVisual } from "./picker-visual";
import { useSelectedPickerItems } from "./selected-items";

const statusToneClass = {
  neutral: badgeToneTextClass.secondary,
  positive: badgeToneTextClass.positive,
  warning: badgeToneTextClass.warning,
  destructive: badgeToneTextClass.destructive,
} as const;

const ENTITY_CODE = {
  ledgerTransfer: "LTR",
  spendingCategory: "SPC",
  ingredient: "ING",
  location: "LOC",
  product: "PRD",
  productCategory: "CAT",
  recipe: "RCP",
  project: "PRJ",
  task: "TSK",
  plant: "PLANT",
  planting: "PLT",
  vendor: "VEN",
  financialAccount: "FAC",
  purchase: "PUR",
  ledgerParty: "LPY",
  vendorAccount: "VACCT",
} satisfies Record<PickerEntity, string>;

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
    item.presentation?.status?.label,
    ...(item.presentation?.facts ?? []),
    ...(item.aliases ?? []),
  ]
    .filter((part): part is string => !!part)
    .some((part) => part.toLocaleLowerCase().includes(query));
}

interface PickerCommonProps<TId extends string> {
  inputId?: string;
  /** Receives the focusable control (the search input, or the choose-mode
   * trigger) so a form can focus the field on a validation error. */
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
   * `search` (default): the field is a text input that filters the roster or
   * drives `onSearchChange`, for records and long lists. `choose`: the field
   * is a button that opens the list with arrow keys and letter typeahead and
   * no text entry, for a short fixed list. Choose mode ignores search, create,
   * and `openOnMount`.
   */
  mode?: "search" | "choose";
  onSearchChange?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
  isLoading?: boolean;
  error?: string | null;
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
  wide?: boolean;
  widthMode?: "default" | "intrinsic";
  compact?: boolean;
  openOnMount?: boolean;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
}

/** A record-valued picker: the value is the whole selected row. */
interface PickerRecordProps<TId extends string> {
  items: ComboboxItem<TId>[];
  value: ComboboxItem<TId> | null;
  setValue: (item: ComboboxItem<TId> | null) => void;
  options?: never;
  onValueChange?: never;
}

/** A string-valued picker over fixed `PickerOption`s. */
interface PickerOptionProps {
  options: readonly PickerOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  items?: never;
  setValue?: never;
}

export type PickerProps<TId extends string = string> = PickerCommonProps<TId> &
  (PickerRecordProps<TId> | PickerOptionProps);

/** A record-valued picker's props — what wrappers that own the roster
 * (search providers, reference pickers) extend. */
export type RecordPickerProps<TId extends string = string> =
  PickerCommonProps<TId> & PickerRecordProps<TId>;

/** The props both modes render from, after options are mapped to rows. */
type ResolvedPickerProps<TId extends string> = RecordPickerProps<TId>;

/**
 * The one value picker. Records (search, create, relationship context) and
 * fixed string options (enums, filters, settings) share its rows, closed
 * display, and popup; `mode` chooses the input contract. Entity shortcodes
 * stay searchable without ever being displayed or announced.
 */
export function Picker<TId extends string = string>(props: PickerProps<TId>) {
  const resolved = useResolvedPickerProps(props);
  const value = useSelectedValue(resolved);
  return resolved.mode === "choose" ? (
    <ChoosePicker {...resolved} value={value} />
  ) : (
    <SearchPicker {...resolved} value={value} />
  );
}

/**
 * A record value the caller could only name by its code (`{ id, name: id }`,
 * an AI seed without a picture) resolves to the record's own row, so the
 * closed field always shows a name and picture.
 */
function useSelectedValue<TId extends string>({
  entity,
  value,
  items,
}: ResolvedPickerProps<TId>): ComboboxItem<TId> | null {
  const held = React.useMemo(
    () => (value ? [value, ...items] : items),
    [value, items],
  );
  const [selected] = useSelectedPickerItems(
    entity,
    value ? [value.id] : [],
    held,
  );
  // SAFETY: the resolved row is built for the same id the caller selected.
  return (selected as ComboboxItem<TId> | undefined) ?? null;
}

const isOptionProps = <TId extends string>(
  props: PickerProps<TId>,
): props is PickerCommonProps<TId> & PickerOptionProps =>
  props.options !== undefined;

function useResolvedPickerProps<TId extends string>(
  props: PickerProps<TId>,
): ResolvedPickerProps<TId> {
  const options = props.options;
  const optionItems = React.useMemo(
    () => (options ? options.map(pickerOptionItem) : null),
    [options],
  );
  if (!isOptionProps(props)) return props;
  const { options: _options, value, onValueChange, ...common } = props;
  // SAFETY: option rows are keyed by `PickerOption.value` strings, and a
  // string-valued picker is never instantiated with a branded id.
  const rows = (optionItems ?? []) as ComboboxItem<TId>[];
  // A stored value the roster no longer offers still reads as itself (an enum
  // value, never a record code).
  // SAFETY: same string-keyed rows as above.
  const missing = { id: value, name: value } as ComboboxItem<TId>;
  const selected =
    value == null ? null : (rows.find((item) => item.id === value) ?? missing);
  return {
    ...common,
    items: rows,
    value: selected,
    setValue: (item) => onValueChange(item?.id ?? null),
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

function selectedLabelOf(value: ComboboxItem | null) {
  if (!value || value.pending) return "";
  return value.secondary ? `${value.name} — ${value.secondary}` : value.name;
}

const fieldFrameClass = (compact: boolean | undefined) =>
  cn(
    "flex w-full min-w-0 items-center gap-2 rounded-sm border border-border bg-card pl-2 transition-colors",
    "focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/30",
    "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 data-[hydrating]:has-[:disabled]:opacity-100",
    compact
      ? "h-7 text-xs/relaxed max-sm:h-11 max-sm:text-base"
      : "h-8 text-sm max-sm:h-11 max-sm:text-base",
  );

const popupClass = (
  wide: boolean | undefined,
  widthMode: "default" | "intrinsic" | undefined,
) =>
  cn(
    "flex max-h-[min(var(--available-height),calc(var(--app-viewport-height,100dvh)_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)_-_1rem),34rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-popover text-popover-foreground shadow-[var(--shadow-overlay)] outline-none",
    "transition-[opacity,scale] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
    wide
      ? widthMode === "intrinsic"
        ? "w-max max-w-[min(44rem,var(--available-width),calc(100vw-16px))]"
        : "w-[min(44rem,calc(100vw-16px))] max-w-(--available-width)"
      : widthMode === "intrinsic"
        ? "w-max max-w-[min(24rem,var(--available-width),calc(100vw-16px))]"
        : "w-[min(24rem,calc(100vw-16px))] max-w-(--available-width)",
    widthMode === "intrinsic"
      ? "min-w-[var(--anchor-width)]"
      : "min-w-[min(var(--anchor-width),calc(100vw-16px))]",
  );

const rowClass = (meta: boolean, custom: boolean) =>
  cn(
    "relative flex min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none select-none max-sm:min-h-11",
    "data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[selected]:bg-accent/50",
    "data-disabled:cursor-not-allowed data-disabled:bg-muted/20 data-disabled:text-muted-foreground",
    meta &&
      "min-h-8 font-mono text-2xs tracking-wider text-slate uppercase max-sm:min-h-11",
    custom && "items-start whitespace-normal",
  );

/** The row's leading visual: a record's row-sized `icon` node, or the shared
 * `PickerVisual` for options (tinted glyph or swatch). */
function PickerRowVisual({
  item,
  custom,
}: {
  item: ComboboxItem;
  custom: boolean;
}) {
  if (item.thumb && item.icon) {
    return (
      <span
        className={cn(
          "flex shrink-0",
          !custom && "-my-2 items-center self-stretch",
        )}
      >
        {item.icon}
      </span>
    );
  }
  return <PickerVisual item={item} size={24} />;
}

function PickerRowContent<TId extends string>({
  item,
  renderItem,
}: {
  item: ComboboxItem<TId>;
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
}) {
  const presentation = item.presentation;
  const status = presentation?.status;
  const facts = presentation?.facts ?? [];
  if (renderItem)
    return <span className="min-w-0 flex-1">{renderItem(item)}</span>;
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-baseline gap-2 max-sm:flex-wrap max-sm:gap-x-2">
        <span className="min-w-0 flex-1 truncate max-sm:basis-full">
          {presentation?.rowLabel ?? item.name}
        </span>
        {item.secondary ? (
          <span className="max-w-40 truncate text-xs text-muted-foreground max-sm:max-w-full">
            {item.secondary}
          </span>
        ) : null}
        {status ? (
          <span
            className={cn(
              "shrink-0 font-mono text-xs tabular-nums",
              statusToneClass[status.tone ?? "neutral"],
            )}
          >
            {status.label}
          </span>
        ) : null}
        {presentation?.hint ? (
          <span className="shrink-0 font-mono text-2xs text-slate tabular-nums">
            {presentation.hint}
          </span>
        ) : null}
      </span>
      {item.detail ? (
        <span className="truncate text-xs text-muted-foreground">
          {item.detail}
        </span>
      ) : null}
      {facts.length > 0 ? (
        <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
          {facts.join(" · ")}
        </span>
      ) : null}
      {presentation?.disabledReason ? (
        <span className="truncate text-xs text-muted-foreground">
          {presentation.disabledReason}
        </span>
      ) : null}
    </span>
  );
}

/** Accessible row name: everything the row shows, never its shortcode. */
function rowAriaLabel(item: ComboboxItem) {
  const presentation = item.presentation;
  return [
    item.name,
    item.secondary,
    item.detail,
    presentation?.status?.label,
    presentation?.hint,
    ...(presentation?.facts ?? []),
    presentation?.disabledReason,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Group headers and the meta/roster divider for row `index` — shared by both
 * modes. Callers own ordering; a header renders whenever the group changes.
 */
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
      {firstAfterMeta ? (
        <div role="presentation" className="my-1 border-t border-border" />
      ) : null}
      {showGroup ? (
        <div
          role="presentation"
          className="border-b border-[var(--border)] bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground first:border-t-0"
        >
          {group.label}
        </div>
      ) : null}
    </>
  );
}

function rowStyle(item: ComboboxItem) {
  const depth = item.presentation?.depth ?? 0;
  return depth > 0 ? { paddingLeft: 8 + depth * 12 } : undefined;
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
function SelectedLead({ value }: { value: ComboboxItem | null }) {
  if (!value) return null;
  if (value.pending) return <Spinner className="size-3.5 shrink-0" />;
  return <PickerVisual item={value} size={20} />;
}

// ---------------------------------------------------------------------------
// Search mode
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
  value,
  noun,
  clearLabel,
  setValue,
  setQuery,
  changeOpen,
  isLoading,
  error,
  emptyMessage,
  wide,
  widthMode,
  create,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  orderedItems: ComboboxItem<TId>[];
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
  clearable?: boolean;
  value: ComboboxItem<TId> | null;
  noun: string;
  clearLabel: string;
  setValue: (value: ComboboxItem<TId> | null) => void;
  setQuery: (query: string) => void;
  changeOpen: (open: boolean) => void;
  isLoading?: boolean;
  error?: string | null;
  emptyMessage: string;
  wide?: boolean;
  widthMode?: "default" | "intrinsic";
  create: CreatePickerItem<TId> | null;
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
      setValue(await create.onCreate(create.name));
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
        <ComboboxPrimitive.Popup className={popupClass(wide, widthMode)}>
          {clearable && value ? (
            <button
              type="button"
              aria-label={clearLabel}
              className="flex min-h-9 w-full shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground max-sm:min-h-11"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setValue(null);
                setQuery("");
                changeOpen(false);
              }}
            >
              <XIcon className="size-3.5" />
              {clearLabel}
            </button>
          ) : null}
          <ComboboxPrimitive.List className="max-h-112 min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none">
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
                  <PickerRowVisual item={item} custom={renderItem != null} />
                  <PickerRowContent item={item} renderItem={renderItem} />
                  <ComboboxPrimitive.ItemIndicator className="shrink-0">
                    <CheckIcon className="size-3.5" />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              </React.Fragment>
            ))}
          </ComboboxPrimitive.List>
          {showStatus ? (
            <div className="shrink-0 border-t border-[var(--border)] px-2 py-4 text-sm">
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
              <div className="shrink-0 border-t border-[var(--border)] px-2 py-4 text-sm text-muted-foreground">
                {emptyMessage}
              </div>
            ) : null}
          </ComboboxPrimitive.Empty>
          {create ? (
            <button
              type="button"
              disabled={isCreating}
              className="flex min-h-9 w-full shrink-0 items-center border-t border-[var(--border)] px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 max-sm:min-h-11"
              onClick={handleCreate}
            >
              {isCreating
                ? `Creating ${noun}…`
                : `Create ${noun}: ${create.name}`}
            </button>
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

/**
 * The input is both the closed display and the open search field, so opening
 * an editor never introduces a second focus target.
 */
function SearchPicker<TId extends string>({
  inputId,
  inputRef: fieldRef,
  "aria-describedby": ariaDescribedBy,
  entity,
  label,
  items,
  value,
  setValue,
  onSearchChange,
  onOpenChange,
  onCreateNew,
  isLoading,
  error,
  renderItem,
  wide,
  widthMode,
  compact,
  openOnMount,
  placeholder,
  clearable,
  disabled,
  className,
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

  const { ariaLabel, noun, clearLabel, placeholderDefault } = pickerNaming(
    entity,
    label,
  );

  const inputValue = open ? query : selectedLabelOf(value);

  const visibleItems = React.useMemo(() => {
    const roster = onSearchChange
      ? items
      : items.filter((item) => matchesPickerItem(item, query));
    if (
      !value ||
      value.pending ||
      query.trim() !== "" ||
      roster.some((item) => item.id === value.id)
    ) {
      return roster;
    }
    return [value, ...roster];
  }, [items, onSearchChange, query, value]);

  const orderedItems = React.useMemo(
    () =>
      visibleItems
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const groupOrderA = a.item.presentation?.group?.order ?? 0;
          const groupOrderB = b.item.presentation?.group?.order ?? 0;
          return groupOrderA - groupOrderB || a.index - b.index;
        })
        .map(({ item }) => item),
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
  const wrongPrefix =
    entity != null && parsedCode != null && parsedCode.type !== entity;
  const searchingForCode =
    normalizedQuery !== "" &&
    (parsedCode != null ||
      (entity != null &&
        normalizedQuery.toUpperCase().startsWith(`${ENTITY_CODE[entity]}-`)));
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

  React.useEffect(() => {
    if (openOnMount) changeOpen(true);
  }, [openOnMount, changeOpen]);

  const emptyMessage = wrongPrefix
    ? `${normalizedQuery.toUpperCase()} is not a ${ENTITY_CODE[entity]} code.`
    : `No ${noun} found.`;

  return (
    <div className={cn("min-w-0", className)}>
      <ComboboxPrimitive.Root<ComboboxItem<TId>>
        items={orderedItems}
        filteredItems={orderedItems}
        filter={null}
        value={value}
        onValueChange={(nextValue) => {
          setValue(nextValue);
          setQuery("");
          changeOpen(false);
        }}
        inputValue={inputValue}
        onInputValueChange={(nextQuery) => {
          if (!open) return;
          setQuery(nextQuery);
        }}
        itemToStringLabel={pickerItemLabel}
        itemToStringValue={pickerItemValue}
        isItemEqualToValue={pickerItemsEqual}
        open={open}
        onOpenChange={changeOpen}
        openOnInputClick
        modal={false}
        autoHighlight
        disabled={gate.disabled}
      >
        <ComboboxPrimitive.InputGroup
          ref={anchorRef}
          data-hydrating={gate["data-hydrating"]}
          className={fieldFrameClass(compact)}
        >
          {open ? null : <SelectedLead value={value} />}
          <ComboboxPrimitive.Input
            id={inputId}
            ref={setInputRef}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            placeholder={
              value?.pending ? "Loading…" : (placeholder ?? placeholderDefault)
            }
            className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {clearable && value ? (
            <ComboboxPrimitive.Clear
              aria-label={clearLabel}
              className="flex h-full shrink-0 items-center justify-center px-1 text-muted-foreground transition-colors hover:text-foreground max-sm:min-h-11 max-sm:min-w-11"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                setValue(null);
                setQuery("");
              }}
            >
              <XIcon className="size-3.5" />
            </ComboboxPrimitive.Clear>
          ) : null}
          <ComboboxPrimitive.Trigger
            aria-label={`Show ${noun} options`}
            className="flex h-full min-w-7 shrink-0 items-center justify-center max-sm:min-w-11"
          >
            <CaretGlyph open={open} />
          </ComboboxPrimitive.Trigger>
        </ComboboxPrimitive.InputGroup>

        <SearchPickerPopup
          anchorRef={anchorRef}
          orderedItems={orderedItems}
          renderItem={renderItem}
          clearable={clearable}
          value={value}
          noun={noun}
          clearLabel={clearLabel}
          setValue={setValue}
          setQuery={setQuery}
          changeOpen={changeOpen}
          isLoading={isLoading}
          error={error}
          emptyMessage={emptyMessage}
          wide={wide}
          widthMode={widthMode}
          create={
            canCreate && onCreateNew
              ? { name: normalizedQuery, onCreate: onCreateNew }
              : null
          }
        />
      </ComboboxPrimitive.Root>
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
  value,
  setValue,
  onOpenChange,
  renderItem,
  wide,
  widthMode,
  compact,
  placeholder,
  clearable,
  disabled,
  className,
}: ResolvedPickerProps<TId>) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const gate = useHydrationGate(disabled);
  const { ariaLabel, clearLabel, placeholderDefault } = pickerNaming(
    entity,
    label,
  );
  const labels = React.useMemo(
    () => items.map((item) => ({ value: item.id, label: item.name })),
    [items],
  );

  return (
    <div className={cn("min-w-0", className)}>
      <SelectPrimitive.Root<string>
        items={labels}
        value={value?.id ?? null}
        onValueChange={(id) =>
          setValue(items.find((item) => item.id === id) ?? null)
        }
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
            className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none"
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
            <span className="flex h-full min-w-7 shrink-0 items-center justify-center max-sm:min-w-11">
              <CaretGlyph open={open} />
            </span>
          </SelectPrimitive.Trigger>
          {clearable && value ? (
            <button
              type="button"
              aria-label={clearLabel}
              disabled={gate.disabled}
              className="flex h-full shrink-0 items-center justify-center px-2 text-muted-foreground transition-colors hover:text-foreground max-sm:min-h-11 max-sm:min-w-11"
              onClick={() => setValue(null)}
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
            <SelectPrimitive.Popup className={popupClass(wide, widthMode)}>
              <SelectPrimitive.List className="max-h-112 min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none">
                {items.map((item, index) => (
                  <React.Fragment key={item.id}>
                    <PickerRowPreamble
                      item={item}
                      previous={items[index - 1]}
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
                      <PickerRowVisual
                        item={item}
                        custom={renderItem != null}
                      />
                      <PickerRowContent item={item} renderItem={renderItem} />
                      <SelectPrimitive.ItemIndicator className="shrink-0">
                        <CheckIcon className="size-3.5" />
                      </SelectPrimitive.ItemIndicator>
                    </SelectPrimitive.Item>
                  </React.Fragment>
                ))}
              </SelectPrimitive.List>
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}
