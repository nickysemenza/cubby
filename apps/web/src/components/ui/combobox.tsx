
import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "~/components/ui/input-group";
import { ChevronDownIcon, XIcon, CheckIcon } from "lucide-react";

const Combobox = ComboboxPrimitive.Root;

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxTrigger({
  className,
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("[&_svg:not([class*='size-'])]:size-3.5", className)}
      {...props}
    >
      {children}
      <ChevronDownIcon className="text-muted-foreground pointer-events-none size-3.5" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroupButton variant="ghost" size="icon-xs" />}
      className={cn(className)}
      {...props}
    >
      <XIcon className="pointer-events-none" />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxInput({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  ...props
}: ComboboxPrimitive.Input.Props & {
  showTrigger?: boolean;
  showClear?: boolean;
}) {
  return (
    <InputGroup className={cn("w-auto", className)}>
      <ComboboxPrimitive.Input
        render={<InputGroupInput disabled={disabled} />}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        {showTrigger && (
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            render={<ComboboxTrigger />}
            data-slot="input-group-button"
            className="group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent"
            disabled={disabled}
          />
        )}
        {showClear && <ComboboxClear disabled={disabled} />}
      </InputGroupAddon>
      {children}
    </InputGroup>
  );
}

function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          data-chips={!!anchor}
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 *:data-[slot=input-group]:bg-input/20 dark group/combobox-content relative max-h-(--available-height) max-h-72 w-(--anchor-width) max-w-(--available-width) min-w-32 min-w-[calc(var(--anchor-width)+--spacing(7))] origin-(--transform-origin) overflow-hidden rounded-lg shadow-md ring-1 duration-100 data-[chips=true]:min-w-(--anchor-width) *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-7 *:data-[slot=input-group]:border-none *:data-[slot=input-group]:shadow-none",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs/relaxed outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      data-slot="combobox-group"
      className={cn(className)}
      {...props}
    />
  );
}

function ComboboxLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)}
      {...props}
    />
  );
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
  return (
    <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "text-muted-foreground hidden w-full justify-center py-2 text-center text-xs/relaxed group-data-empty/combobox-content:flex",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxSeparator({
  className,
  ...props
}: ComboboxPrimitive.Separator.Props) {
  return (
    <ComboboxPrimitive.Separator
      data-slot="combobox-separator"
      className={cn("bg-border/50 -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function ComboboxChips({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
  ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        "bg-input/20 border-input focus-within:border-ring focus-within:ring-ring/30 has-aria-invalid:ring-destructive/20 has-aria-invalid:border-destructive flex min-h-7 flex-wrap items-center gap-1 rounded-md border bg-clip-padding px-2 py-0.5 text-xs/relaxed transition-colors focus-within:ring-[2px] has-aria-invalid:ring-[2px] has-data-[slot=combobox-chip]:px-1",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: ComboboxPrimitive.Chip.Props & {
  showRemove?: boolean;
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        "bg-muted-foreground/10 text-foreground flex h-[calc(--spacing(4.75))] w-fit items-center justify-center gap-1 rounded-[calc(var(--radius-sm)-2px)] px-1.5 text-xs/relaxed font-medium whitespace-nowrap has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0",
        className,
      )}
      {...props}
    >
      {children}
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          render={<Button variant="ghost" size="icon-xs" />}
          className="-ml-1 opacity-50 hover:opacity-100"
          data-slot="combobox-chip-remove"
        >
          <XIcon className="pointer-events-none" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  );
}

function ComboboxChipsInput({
  className,
  ...props
}: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cn("min-w-16 flex-1 outline-none", className)}
      {...props}
    />
  );
}

function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null);
}

/**
 * FilterableCombobox wraps Combobox with manual filtering.
 * Pass items as a prop and it filters as you type while enforcing selection.
 */
export interface FilterableComboboxItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
  color?: string;
}

interface FilterableComboboxProps {
  items: FilterableComboboxItem[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

function FilterableCombobox({
  items,
  value,
  onValueChange,
  placeholder,
  className,
  disabled,
}: FilterableComboboxProps) {
  const [inputValue, setInputValue] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  // Filter items based on input
  const filteredItems = React.useMemo(() => {
    if (!inputValue) return items;
    const lower = inputValue.toLowerCase();
    return items.filter((item) => item.label.toLowerCase().includes(lower));
  }, [items, inputValue]);

  // Get label for current value
  const selectedLabel = items.find((item) => item.value === value)?.label ?? "";

  return (
    <ComboboxPrimitive.Root
      value={value}
      onValueChange={(newValue) => {
        onValueChange(newValue);
        setInputValue(""); // Clear filter on selection
      }}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      {/* Polished trigger with proper borders and hover states */}
      <ComboboxPrimitive.Trigger
        ref={triggerRef}
        className={cn(
          // Structure
          "flex w-full items-center justify-between gap-1.5 rounded-md border px-2 h-7",
          // Colors & background
          "border-input bg-input/20",
          "hover:bg-input/30",
          // Focus states
          "focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[2px]",
          // Typography
          "text-xs/relaxed",
          // Transitions
          "transition-colors duration-150 outline-none",
          // Disabled
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        {/* Input for filtering when open, display value when closed */}
        <ComboboxPrimitive.Input
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          placeholder={placeholder}
          value={open ? inputValue : selectedLabel}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setInputValue(e.target.value)
          }
        />
        {/* Animated chevron */}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </ComboboxPrimitive.Trigger>

      {/* Refined popup */}
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          anchor={triggerRef}
          className="isolate z-50"
        >
          <ComboboxPrimitive.Popup
            className={cn(
              // Base
              "bg-popover text-popover-foreground",
              // Size constraints - match trigger width
              "w-(--anchor-width)",
              // Shape & depth
              "rounded-md border border-border/50 shadow-lg",
              // Animation
              "data-open:animate-in data-closed:animate-out",
              "data-closed:fade-out-0 data-open:fade-in-0",
              "data-closed:zoom-out-95 data-open:zoom-in-95",
              "data-[side=bottom]:slide-in-from-top-1",
              "origin-(--transform-origin) duration-150",
            )}
          >
            <ComboboxPrimitive.List className="max-h-60 overflow-y-auto overscroll-contain p-0.5">
              {filteredItems.map((item) => (
                <ComboboxPrimitive.Item
                  key={item.value}
                  value={item.value}
                  className={cn(
                    // Compact layout
                    "relative flex items-center gap-2 rounded-sm px-2 py-1",
                    // Typography
                    "cursor-default text-xs outline-none select-none",
                    // Interactive states
                    "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                    // Selected state - subtle background highlight
                    "data-[selected]:bg-accent/50",
                    // Disabled
                    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                  )}
                  style={
                    item.color
                      ? {
                          backgroundColor: `color-mix(in srgb, ${item.color} 15%, transparent)`,
                        }
                      : undefined
                  }
                >
                  <ComboboxPrimitive.ItemIndicator className="shrink-0">
                    <CheckIcon className="size-3.5" />
                  </ComboboxPrimitive.ItemIndicator>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.icon && (
                    <span className="shrink-0">{item.icon}</span>
                  )}
                </ComboboxPrimitive.Item>
              ))}
            </ComboboxPrimitive.List>
            {filteredItems.length === 0 && (
              <div className="py-2 text-center text-muted-foreground text-xs">
                No results
              </div>
            )}
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}

export {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxSeparator,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxTrigger,
  ComboboxValue,
  FilterableCombobox,
  useComboboxAnchor,
};
