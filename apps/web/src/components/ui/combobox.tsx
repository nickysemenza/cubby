import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils";

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

export function FilterableCombobox({
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
          "border-border bg-input/20",
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
              "rounded-md border border-[var(--border-chunky)] shadow-[var(--shadow-chunky-sm)]",
              // Animation
              "data-open:animate-in data-closed:animate-out",
              "data-closed:fade-out-0 data-open:fade-in-0",
              "data-closed:zoom-out-95 data-open:zoom-in-95",
              "data-[side=bottom]:slide-in-from-top-1",
              "origin-(--transform-origin) duration-150",
            )}
          >
            <ComboboxPrimitive.List className="max-h-60 overflow-y-auto overscroll-contain p-1">
              {filteredItems.map((item) => (
                <ComboboxPrimitive.Item
                  key={item.value}
                  value={item.value}
                  className={cn(
                    // Compact layout
                    "relative flex items-center gap-2 rounded-md px-2 py-1",
                    // Typography
                    "cursor-default text-xs outline-none select-none",
                    // Interactive states
                    "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                    // Selected state - subtle background highlight
                    "data-[selected]:bg-accent/50",
                    // Disabled
                    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                  )}
                >
                  <ComboboxPrimitive.ItemIndicator className="shrink-0">
                    <CheckIcon className="size-3.5" />
                  </ComboboxPrimitive.ItemIndicator>
                  {item.color && (
                    <span
                      aria-hidden
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                  )}
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
