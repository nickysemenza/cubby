import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { parseShortcode } from "@cubby/shared";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { CheckIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { ComboboxItem, PickerEntity } from "./combobox-types";

const ENTITY_CODE: Record<PickerEntity, string> = {
  ingredient: "ING",
  location: "LOC",
  product: "PRD",
  recipe: "RCP",
  project: "PRJ",
  task: "TSK",
  vendor: "VEN",
  financialAccount: "FAC",
  purchase: "PUR",
};

export function matchesPickerItem(
  item: ComboboxItem,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [item.name, item.shortcode, item.secondary, ...(item.aliases ?? [])]
    .filter((part): part is string => !!part)
    .some((part) => part.toLocaleLowerCase().includes(query));
}

export interface EntityPickerProps<TId extends string> {
  entity?: PickerEntity;
  label: string;
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
  autoFocus?: boolean;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
}

/**
 * The shared Base UI assignment picker. The input is both the closed display
 * and the open search field, so opening an editor never introduces a second
 * focus target. Entity shortcodes remain searchable metadata without becoming
 * visual chrome; USDA and static form pickers reuse the shell without an
 * entity and may supply their own rich rows.
 */
export function EntityPicker<TId extends string>({
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
  autoFocus,
  placeholder,
  clearable,
  disabled,
}: EntityPickerProps<TId>) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debouncedQuery] = useDebouncedValue(query, { wait: 300 });
  const [isCreating, setIsCreating] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

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
    if (autoFocus) changeOpen(true);
  }, [autoFocus, changeOpen]);

  const emptyMessage = wrongPrefix
    ? `${normalizedQuery.toUpperCase()} is not a ${ENTITY_CODE[entity]} code.`
    : `No ${label} found.`;

  return (
    <ComboboxPrimitive.Root<ComboboxItem<TId>>
      items={visibleItems}
      filteredItems={visibleItems}
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
      <ComboboxPrimitive.InputGroup
        ref={anchorRef}
        className="flex w-full items-stretch"
      >
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center border border-border bg-input/20 transition-colors focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/30 hover:bg-input/30",
            "rounded-sm",
            compact ? "h-7" : "h-9 max-sm:h-10",
          )}
        >
          <ComboboxPrimitive.Input
            ref={inputRef}
            aria-label={label}
            placeholder={placeholder ?? `Select ${label}…`}
            className={cn(
              "min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-muted-foreground",
              compact ? "text-xs/relaxed" : "text-sm",
            )}
          />
          {clearable && value && (
            <ComboboxPrimitive.Clear
              aria-label={`Clear ${label}`}
              className="flex h-full shrink-0 items-center px-2 text-muted-foreground transition-colors hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                setQuery("");
              }}
            >
              <XIcon className="size-3.5" />
            </ComboboxPrimitive.Clear>
          )}
        </div>
      </ComboboxPrimitive.InputGroup>

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
              "max-w-(--available-width) origin-(--transform-origin) rounded-none border border-[var(--border)] bg-popover text-popover-foreground",
              "data-open:fade-in-0 data-open:zoom-in-95 data-open:animate-in",
              wide
                ? "w-[min(44rem,calc(100vw-16px))]"
                : "w-[min(24rem,calc(100vw-16px))]",
              "min-w-[min(var(--anchor-width),calc(100vw-16px))]",
            )}
          >
            {clearable && value && (
              <button
                type="button"
                aria-label={`Clear ${label}`}
                className="flex w-full items-center gap-2 border-[var(--border)] border-b px-2 py-2 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setValue(null);
                  setQuery("");
                  changeOpen(false);
                }}
              >
                <XIcon className="size-3.5" />
                Clear {label}
              </button>
            )}
            <ComboboxPrimitive.List className="max-h-[min(var(--available-height),28rem)] overflow-y-auto overscroll-contain p-1 outline-none">
              {visibleItems.map((item) => (
                <ComboboxPrimitive.Item
                  key={item.id}
                  value={item}
                  aria-label={[item.name, item.secondary, item.shortcode]
                    .filter(Boolean)
                    .join(" ")}
                  className={cn(
                    "relative flex cursor-default select-none items-center gap-2 rounded-none px-2 py-2 text-left text-sm outline-none",
                    "data-[selected]:bg-accent/50 data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                    renderItem && "items-start whitespace-normal",
                  )}
                >
                  {item.color && (
                    <span
                      aria-hidden
                      className="size-2 shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                  )}
                  {item.icon && <span className="shrink-0">{item.icon}</span>}
                  {renderItem ? (
                    <span className="min-w-0 flex-1">{renderItem(item)}</span>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {item.name}
                      </span>
                      {item.secondary && (
                        <span className="max-w-40 truncate text-muted-foreground text-xs">
                          {item.secondary}
                        </span>
                      )}
                    </span>
                  )}
                  <ComboboxPrimitive.ItemIndicator className="shrink-0">
                    <CheckIcon className="size-3.5" />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              ))}
            </ComboboxPrimitive.List>

            {(isLoading || error || visibleItems.length === 0) && (
              <div className="border-[var(--border)] border-t px-2 py-4 text-sm">
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
            )}

            {canCreate && (
              <button
                type="button"
                disabled={isCreating}
                className="flex w-full items-center border-[var(--border)] border-t px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                onClick={async (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const name = normalizedQuery;
                  setIsCreating(true);
                  // Dialog-backed creators must open outside the combobox's
                  // modal focus surface or Base UI will mark the dialog inert.
                  changeOpen(false);
                  try {
                    await new Promise<void>((resolve) =>
                      requestAnimationFrame(() => resolve()),
                    );
                    const created = await onCreateNew(name);
                    setValue(created);
                    setQuery("");
                  } catch {
                    changeOpen(true);
                    setQuery(name);
                  } finally {
                    setIsCreating(false);
                  }
                }}
              >
                {isCreating
                  ? `Creating ${label}…`
                  : `Create ${label}: ${normalizedQuery}`}
              </button>
            )}
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
