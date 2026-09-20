import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { parseShortcode } from "@cubby/shared";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { CheckIcon, XIcon } from "lucide-react";
import * as React from "react";

import { Spinner } from "~/components/ui/spinner";
import { entityLabel } from "~/entities/entities";
import { cn } from "~/lib/utils";

import type {
  ComboboxItem,
  PickerEntity,
  PickerPresentation,
} from "./combobox-types";

const statusToneClass = {
  neutral: "text-muted-foreground",
  positive: "text-positive",
  warning: "text-warning-ink",
  destructive: "text-destructive",
} as const;

const ENTITY_CODE = {
  ingredient: "ING",
  location: "LOC",
  product: "PRD",
  recipe: "RCP",
  project: "PRJ",
  task: "TSK",
  planting: "PLT",
  vendor: "VEN",
  financialAccount: "FAC",
  purchase: "PUR",
  ledgerParty: "LPY",
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

export interface EntityPickerProps<TId extends string> {
  inputId?: string;
  entity?: PickerEntity;
  /**
   * Visible caption for assistive tech (falls back to the entity's noun when
   * omitted). Not used for the placeholder, "Clear …", or "Create …" strings
   * — those always name the entity, never a caller's sentence-length field
   * caption. See `pickerNaming`.
   */
  label?: string;
  items: ComboboxItem<TId>[];
  value: ComboboxItem<TId> | null;
  setValue: (item: ComboboxItem<TId> | null) => void;
  onSearchChange?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
  isLoading?: boolean;
  error?: string | null;
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
  wide?: boolean;
  compact?: boolean;
  openOnMount?: boolean;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
}

function EntityPickerItem<TId extends string>({
  item,
  previous,
  renderItem,
}: {
  item: ComboboxItem<TId>;
  previous?: ComboboxItem<TId>;
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
}) {
  const group = item.presentation?.group;
  const showGroup = group && group.id !== previous?.presentation?.group?.id;
  const status = item.presentation?.status;
  const facts = item.presentation?.facts ?? [];
  const disabledReason = item.presentation?.disabledReason;
  return (
    <React.Fragment>
      {showGroup ? (
        <div
          role="presentation"
          className="border-b border-[var(--border)] bg-muted/40 px-2 py-1 font-mono text-[0.625rem] tracking-wider text-muted-foreground uppercase first:border-t-0"
        >
          {group.label}
        </div>
      ) : null}
      <ComboboxPrimitive.Item
        value={item}
        disabled={disabledReason != null}
        aria-label={[
          item.name,
          item.secondary,
          item.detail,
          status?.label,
          ...facts,
          disabledReason,
          item.shortcode,
        ]
          .filter(Boolean)
          .join(" ")}
        className={cn(
          "relative flex min-h-9 cursor-default items-center gap-2 rounded-none px-2 py-2 text-left text-sm outline-none select-none max-sm:min-h-11",
          "data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[selected]:bg-accent/50",
          "data-disabled:cursor-not-allowed data-disabled:bg-muted/20 data-disabled:text-muted-foreground",
          renderItem && "items-start whitespace-normal",
        )}
      >
        {item.color ? (
          <span
            aria-hidden
            className="size-2 shrink-0"
            style={{ backgroundColor: item.color }}
          />
        ) : null}
        {item.icon ? (
          <span
            className={cn(
              "flex shrink-0",
              !renderItem && "-my-2 items-center self-stretch",
            )}
          >
            {item.icon}
          </span>
        ) : null}
        <EntityPickerItemContent
          item={item}
          status={status}
          facts={facts}
          disabledReason={disabledReason}
          renderItem={renderItem}
        />
        <ComboboxPrimitive.ItemIndicator className="shrink-0">
          <CheckIcon className="size-3.5" />
        </ComboboxPrimitive.ItemIndicator>
      </ComboboxPrimitive.Item>
    </React.Fragment>
  );
}

function EntityPickerItemContent<TId extends string>({
  item,
  status,
  facts,
  disabledReason,
  renderItem,
}: {
  item: ComboboxItem<TId>;
  status: PickerPresentation["status"];
  facts: string[];
  disabledReason: string | undefined;
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
}) {
  if (renderItem)
    return <span className="min-w-0 flex-1">{renderItem(item)}</span>;
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-baseline gap-2 max-sm:flex-wrap max-sm:gap-x-2">
        <span className="min-w-0 flex-1 truncate max-sm:basis-full">
          {item.name}
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
      {disabledReason ? (
        <span className="truncate text-xs text-muted-foreground">
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}

type CreatePickerItem<TId extends string> = {
  name: string;
  onCreate: (name: string) => Promise<ComboboxItem<TId>>;
};

/** The popup owns result status and the create transition; the input owns focus. */
function EntityPickerPopup<TId extends string>({
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
  create,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  orderedItems: ComboboxItem<TId>[];
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
  clearable?: boolean;
  value: ComboboxItem<TId> | null;
  /**
   * Entity noun (never the caller's sentence-length caption) for "Clear …" /
   * "Create …" text.
   */
  noun: string;
  clearLabel: string;
  setValue: (value: ComboboxItem<TId> | null) => void;
  setQuery: (query: string) => void;
  changeOpen: (open: boolean) => void;
  isLoading?: boolean;
  error?: string | null;
  emptyMessage: string;
  wide?: boolean;
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
      changeOpen(true);
      setQuery(create.name);
    } finally {
      setIsCreating(false);
    }
  };
  const showStatus = isLoading || error || orderedItems.length === 0;
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side="bottom"
        sideOffset={4}
        align="start"
        collisionPadding={8}
        anchor={anchorRef}
        data-combobox-popup=""
        className="isolate z-[200]"
      >
        <ComboboxPrimitive.Popup
          className={cn(
            "flex max-h-[min(var(--available-height),calc(var(--app-viewport-height,100dvh)_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)_-_1rem),34rem)] max-w-(--available-width) origin-(--transform-origin) flex-col overflow-hidden rounded-none border border-[var(--border)] bg-popover text-popover-foreground",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            wide
              ? "w-[min(44rem,calc(100vw-16px))]"
              : "w-[min(24rem,calc(100vw-16px))]",
            "min-w-[min(var(--anchor-width),calc(100vw-16px))",
          )}
        >
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
              <EntityPickerItem
                key={item.id}
                item={item}
                previous={orderedItems[index - 1]}
                renderItem={renderItem}
              />
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
              ) : (
                <span className="text-muted-foreground">{emptyMessage}</span>
              )}
            </div>
          ) : null}
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

/**
 * The visible caption (e.g. "Location where this happened") is only ever an
 * accessible name. Every string that names the *thing being picked* —
 * placeholder, "Clear …", "Create …", "No … found." — uses the entity's own
 * noun, or a caption like that renders as "Select Location where this
 * happened…". Callers with no entity key (USDA search, static pickers) keep
 * using `label` as that noun, matching their pre-existing contract.
 */
function pickerNaming(
  entity: PickerEntity | undefined,
  label: string | undefined,
) {
  const entityName = entity ? entityLabel(entity) : null;
  const entityNoun = entityName?.toLowerCase() ?? null;
  return {
    ariaLabel: label ?? entityName ?? "",
    noun: entityNoun ?? label ?? "item",
    // The clear control names the field it clears ("Clear parent location"),
    // which is the visible caption when one is given.
    clearLabel: `Clear ${label ?? entityNoun ?? "value"}`,
    placeholderDefault: entityNoun
      ? `Choose ${/^[aeiou]/i.test(entityNoun) ? "an" : "a"} ${entityNoun}…`
      : "Choose…",
  };
}

function EntityPickerInput<TId extends string>({
  inputId,
  anchorRef,
  inputRef,
  ariaLabel,
  clearLabel,
  placeholderDefault,
  placeholder,
  compact,
  clearable,
  value,
  setValue,
  setQuery,
}: {
  inputId?: string;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Visible caption (or entity fallback) — accessible name for the input. */
  ariaLabel: string;
  /** "Clear <caption>" — names the field the control clears. */
  clearLabel: string;
  /**
   * "Choose a <entity>…", or "Choose…" with no entity key — overridden by
   * `placeholder`.
   */
  placeholderDefault: string;
  placeholder?: string;
  compact?: boolean;
  clearable?: boolean;
  value: ComboboxItem<TId> | null;
  setValue: (value: ComboboxItem<TId> | null) => void;
  setQuery: (query: string) => void;
}) {
  return (
    <ComboboxPrimitive.InputGroup
      ref={anchorRef}
      className="flex w-full items-stretch"
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center border border-border bg-input/20 transition-colors focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/30 hover:bg-input/30",
          "rounded-sm",
          compact ? "h-7 max-sm:h-11" : "h-9 max-sm:h-11",
        )}
      >
        <ComboboxPrimitive.Input
          id={inputId}
          ref={inputRef}
          aria-label={ariaLabel}
          placeholder={placeholder ?? placeholderDefault}
          className={cn(
            "min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-muted-foreground",
            compact
              ? "text-xs/relaxed max-sm:text-base"
              : "text-sm max-sm:text-base",
          )}
        />
        {clearable && value ? (
          <ComboboxPrimitive.Clear
            aria-label={clearLabel}
            className="flex h-full shrink-0 items-center justify-center px-2 text-muted-foreground transition-colors hover:text-foreground max-sm:min-h-11 max-sm:min-w-11"
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
      </div>
    </ComboboxPrimitive.InputGroup>
  );
}

/**
 * The shared Base UI assignment picker. The input is both the closed display
 * and the open search field, so opening an editor never introduces a second
 * focus target. Entity shortcodes remain searchable metadata without becoming
 * visual chrome; USDA and static form pickers reuse the shell without an
 * entity and may supply their own rich rows.
 */
export function EntityPicker<TId extends string>({
  inputId,
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
  compact,
  openOnMount,
  placeholder,
  clearable,
  disabled,
}: EntityPickerProps<TId>) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debouncedQuery] = useDebouncedValue(query, { wait: 150 });
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const { ariaLabel, noun, clearLabel, placeholderDefault } = pickerNaming(
    entity,
    label,
  );

  const selectedLabel = value
    ? value.secondary
      ? `${value.name} — ${value.secondary}`
      : value.name
    : "";
  const inputValue = open ? query : selectedLabel;

  const visibleItems = React.useMemo(() => {
    const roster = onSearchChange
      ? items
      : items.filter((item) => matchesPickerItem(item, query));
    if (
      !value ||
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
      itemToStringLabel={(item) => item.name}
      itemToStringValue={(item) => item.id}
      isItemEqualToValue={(item, selected) => item.id === selected.id}
      open={open}
      onOpenChange={changeOpen}
      openOnInputClick
      modal={false}
      autoHighlight
      disabled={disabled}
    >
      <EntityPickerInput
        inputId={inputId}
        anchorRef={anchorRef}
        inputRef={inputRef}
        ariaLabel={ariaLabel}
        clearLabel={clearLabel}
        placeholderDefault={placeholderDefault}
        placeholder={placeholder}
        compact={compact}
        clearable={clearable}
        value={value}
        setValue={setValue}
        setQuery={setQuery}
      />

      <EntityPickerPopup
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
        create={
          canCreate && onCreateNew
            ? { name: normalizedQuery, onCreate: onCreateNew }
            : null
        }
      />
    </ComboboxPrimitive.Root>
  );
}
