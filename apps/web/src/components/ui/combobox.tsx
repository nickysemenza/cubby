import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils";
import { focusOnMount as focusElementOnMount } from "~/hooks/focus-on-mount";

/**
 * FilterableCombobox wraps Combobox with manual filtering.
 * Pass items as a prop and it filters as you type while enforcing selection.
 */
export interface FilterableComboboxItem {
  value: string;
  label: string;
  /** Leading glyph — a trade icon, a category mark, a vendor's brand logo. */
  icon?: React.ReactNode;
  color?: string;
  /**
   * Trailing micro-annotation ABOUT the option — today, how many rows carry it
   * ("254"). Deliberately its own field rather than baked into `label`: the
   * label is interpolated verbatim into `LedgerFilters` and the collapsed
   * multi-select summary (`"Amazon (254) +1"` reads as nonsense), and the local
   * type-ahead matches on `label`, so a count in there means typing digits
   * filters the roster by its counts.
   */
  hint?: string;
  /**
   * Trailing prose annotation that DISAMBIGUATES the option — today, a
   * location's ancestor breadcrumb, because "shelf 1" exists in four rooms.
   * Separate from `hint`: that slot is a mono/tabular-nums count register, and
   * a breadcrumb rendered there reads as data rather than as context. Like
   * `hint` it stays out of `label`, which is interpolated verbatim into
   * `LedgerFilters` and the collapsed multi-select summary.
   */
  detail?: string;
  /**
   * A meta option is a predicate ABOUT the data (e.g. "Has project" / "(none)"
   * nullable-filter sentinels), not a value drawn FROM it — it renders in the
   * eyebrow register instead of alongside the roster it sits above. `label`
   * still MUST stay a plain string even for meta items: `LedgerFilters` and
   * the collapsed multi-combobox summary interpolate it into `${label} +${n}`.
   */
  meta?: boolean;
}

interface FilterableComboboxProps {
  items: FilterableComboboxItem[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  // Server-search mode: when `onSearchChange` is provided, `items` is treated as
  // the already-filtered result set from the server and local filtering is
  // skipped. `onOpenChange` lets a deferred-search host gate its query on the
  // picker's open state; `isLoading` reflects the in-flight search.
  onSearchChange?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  isLoading?: boolean;
  /** Focus the filter input on mount (e.g. an inline cell editor). */
  focusOnMount?: boolean;
  /**
   * Render an inline `X` that clears the selection back to "no filter".
   * Opt-in: most consumers are pickers for a REQUIRED value (inline cell
   * editors, `rows-per-page-select`) where an empty state is meaningless.
   *
   * Deliberately a plain button rather than Base UI's `<Combobox.Clear>`:
   * that part writes the *store's* input value, but this component controls
   * `<Combobox.Input>` with local React state, so the store write is a no-op
   * on what the user sees. (Its `visible` logic also requires `Combobox.Chips`
   * in multiple mode, which doesn't fit a compact filter control.)
   */
  clearable?: boolean;
  ariaLabel?: string;
}

export function FilterableCombobox({
  items,
  value,
  onValueChange,
  placeholder,
  className,
  disabled,
  onSearchChange,
  onOpenChange,
  isLoading,
  focusOnMount,
  clearable,
  ariaLabel,
}: FilterableComboboxProps) {
  const [inputValue, setInputValue] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement>(null);

  const serverSearch = onSearchChange != null;

  // In server-search mode the server already filtered; otherwise filter the
  // static items array locally as the user types.
  const filteredItems = React.useMemo(() => {
    if (serverSearch) return items;
    if (!inputValue) return items;
    const lower = inputValue.toLowerCase();
    return items.filter((item) => item.label.toLowerCase().includes(lower));
  }, [items, inputValue, serverSearch]);

  // Get label for current value
  const selectedLabel = items.find((item) => item.value === value)?.label ?? "";

  return (
    <ComboboxPrimitive.Root
      value={value}
      onValueChange={(newValue) => {
        onValueChange(newValue);
        setInputValue(""); // Clear filter on selection
        onSearchChange?.("");
      }}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
      disabled={disabled}
    >
      {/* Keep the editable input and popup button as siblings. Nesting the
          textbox inside a button creates invalid, inaccessible interactive
          markup. */}
      <ComboboxPrimitive.InputGroup
        ref={anchorRef}
        className={cn(
          // Structure
          "flex h-9 max-sm:h-11 w-full items-center justify-between gap-1.5 rounded-md border bg-card px-2.5",
          // Colors & background
          "border-border bg-input/20",
          "hover:bg-input/30",
          // Focus states
          "focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[2px]",
          // Typography
          "text-xs/relaxed",
          // Transitions
          "transition-colors duration-150 outline-none",
          // Disabled
          "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
          className,
        )}
      >
        {/* Input for filtering when open, display value when closed */}
        <ComboboxPrimitive.Input
          aria-label={ariaLabel}
          ref={focusOnMount ? focusElementOnMount : undefined}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          placeholder={placeholder}
          value={open ? inputValue : selectedLabel}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setInputValue(e.target.value);
            onSearchChange?.(e.target.value);
          }}
        />
        {clearable && value != null && (
          <button
            type="button"
            aria-label="Clear filter"
            // preventDefault on mousedown so the click doesn't focus the input
            // and pop the list open on its way out.
            onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              setInputValue("");
              onSearchChange?.("");
              onValueChange(null);
            }}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        )}
        <ComboboxPrimitive.Trigger
          aria-label={`Open ${placeholder ?? "options"}`}
          className="-mr-2 flex h-full min-w-7 shrink-0 items-center justify-center"
        >
          <ChevronDownIcon
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </ComboboxPrimitive.Trigger>
      </ComboboxPrimitive.InputGroup>

      <ComboboxPopup
        items={filteredItems}
        anchorRef={anchorRef}
        isLoading={isLoading}
      />
    </ComboboxPrimitive.Root>
  );
}

/**
 * The portaled list, shared verbatim by the single- and multi-select
 * comboboxes. Markup only — it reads selection state from `Combobox.Root`
 * context, so it works under either selection mode. Kept as a child rather
 * than a generic wrapper because `Combobox.Root`'s `multiple` prop must be a
 * literal `true`/`false` for its value type to infer; a shared Root taking a
 * boolean would collapse the value to `string | string[]` for every consumer.
 */
function ComboboxPopup({
  items,
  anchorRef,
  isLoading,
}: {
  items: FilterableComboboxItem[];
  anchorRef: React.RefObject<HTMLDivElement | null>;
  isLoading?: boolean;
}) {
  // Where the leading meta block (nullable-filter sentinels) ends and the real
  // roster begins — the hairline goes above this index. `> 0` is the "list
  // actually mixes the two" test: 0 means no meta items lead the list, -1 means
  // every item is meta.
  const rosterStart = items.findIndex((i) => !i.meta);
  return (
    <>
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          anchor={anchorRef}
          // Marks the portaled dropdown so cell-editor-overlay's click-outside
          // check (DOM containment) doesn't treat clicks in here as "outside".
          data-combobox-popup=""
          // z-[200] (was z-50): must paint above CellEditorOverlay (z-100),
          // matching the entity picker's dropdown layer.
          className="isolate z-[200]"
        >
          <ComboboxPrimitive.Popup
            className={cn(
              // Base
              "bg-popover text-popover-foreground",
              // Size constraints - match trigger width
              "w-(--anchor-width)",
              // Shape — flat ruled panel, no elevation
              "rounded-lg border border-[var(--border)] shadow-[var(--shadow-overlay)]",
              // Animation
              "data-open:animate-in data-closed:animate-out",
              "data-closed:fade-out-0 data-open:fade-in-0",
              "duration-150",
              "data-[side=bottom]:slide-in-from-top-1",
              "origin-(--transform-origin) duration-150",
            )}
          >
            <ComboboxPrimitive.List className="max-h-60 overflow-y-auto overscroll-contain p-1">
              {items.map((item, index) => {
                const isFirstNonMeta =
                  rosterStart > 0 && index === rosterStart;
                return (
                  <ComboboxPrimitive.Item
                    key={item.value}
                    value={item.value}
                    className={cn(
                      // Compact layout
                      "relative flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5",
                      // Typography
                      "cursor-default text-xs outline-none select-none",
                      // Interactive states
                      "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                      // Selected state - subtle background highlight
                      "data-[selected]:bg-accent/50",
                      // Disabled
                      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                      // Meta options (nullable-filter sentinels) render in the
                      // eyebrow register — a predicate about the data, not a
                      // value drawn from it.
                      item.meta &&
                        "font-mono text-2xs uppercase tracking-wider text-slate",
                      isFirstNonMeta && "border-t border-[var(--border)]",
                    )}
                  >
                    <ComboboxPrimitive.ItemIndicator className="shrink-0">
                      <CheckIcon className="size-3.5" />
                    </ComboboxPrimitive.ItemIndicator>
                    {item.icon ? (
                      <span
                        aria-hidden
                        data-enum-option-icon=""
                        className="flex shrink-0 items-center [&>svg]:size-3.5!"
                        style={{ color: item.color }}
                      >
                        {item.icon}
                      </span>
                    ) : item.color ? (
                      <span
                        aria-hidden
                        data-enum-option-swatch=""
                        className="inline-block size-2 shrink-0 rounded-sm"
                        style={{ backgroundColor: item.color }}
                      />
                    ) : null}
                    {item.detail ? (
                      // Second line, not a trailing column: the label is what
                      // the user is picking, and sharing the row with a
                      // breadcrumb truncated it to "2 drawer pa…".
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{item.label}</span>
                        <span className="truncate text-2xs text-muted-foreground">
                          {item.detail}
                        </span>
                      </span>
                    ) : (
                      <span className="flex-1 truncate">{item.label}</span>
                    )}
                    {item.hint && (
                      <span className="shrink-0 font-mono text-2xs text-slate tabular-nums">
                        {item.hint}
                      </span>
                    )}
                  </ComboboxPrimitive.Item>
                );
              })}
            </ComboboxPrimitive.List>
            {items.length === 0 && (
              <div className="py-2 text-center text-muted-foreground text-xs">
                {isLoading ? "Searching…" : "No results"}
              </div>
            )}
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </>
  );
}
