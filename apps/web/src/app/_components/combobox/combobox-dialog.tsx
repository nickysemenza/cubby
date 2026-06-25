import { useDebouncedValue } from "@tanstack/react-pacer";
import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { ComboboxItem } from "./combobox-types";

/**
 * DialogCompatibleCombobox
 *
 * This component provides a custom combobox implementation specifically designed to work
 * properly when used inside Radix UI Dialog components. It addresses several critical issues
 * that occur when using the standard Combobox within nested dialogs:
 *
 * 1. Focus Trapping Conflicts:
 *    - Radix Dialog uses a focus trap to keep focus within the dialog for accessibility
 *    - The standard Combobox also uses cmdk (Command Menu), which is built on Radix Dialog
 *    - This creates nested dialogs with competing focus traps
 *    - Result: Keyboard events get captured by the parent dialog and never reach the combobox
 *
 * 2. Portal/Stacking Issues:
 *    - Both Dialog and Combobox use portals to render content at the root level
 *    - This creates z-index conflicts and event handling problems
 *
 * 3. Event Propagation Problems:
 *    - Click events inside the combobox can accidentally submit the parent form
 *
 * This implementation:
 *    - Uses native DOM elements instead of Radix UI components
 *    - Manages its own focus state with refs
 *    - Has higher z-index (200) to appear above dialogs
 *    - Prevents event propagation to parent dialogs
 *    - Explicitly prevents form submission with type="button" and stopPropagation()
 *    - Handles clicks outside to close the dropdown
 *
 * When to use:
 * - Use this component when you need a combobox inside a dialog/modal
 * - For comboboxes in regular page content, use the standard Combobox
 *
 * Implementation note: The standard Combobox uses cmdk which is built on Radix Dialog.
 * This creates nested dialogs with incompatible focus management when used inside another dialog.
 */
export function DialogCompatibleCombobox<TId extends string = string>({
  label,
  items,
  onSearchChange,
  isLoading,
  value,
  setValue,
  onCreateNew,
  onOpenChange,
  renderItem,
  wide,
}: {
  label: string;
  items: ComboboxItem<TId>[];
  onSearchChange: (query: string) => void;
  isLoading?: boolean;
  value: ComboboxItem<TId> | null;
  setValue: (item: ComboboxItem<TId> | null) => void;
  onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
  /**
   * Notified whenever the dropdown opens or closes. Lets an async-search parent
   * defer its options query until the user actually opens the picker, instead of
   * firing it on mount (keeps the list query off the page's critical path).
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Optional custom renderer for each dropdown row. When provided it replaces the
   * default truncated-name span, and rows switch to a multi-line layout. The
   * trigger button still shows `value.name`. Used by the USDA food search to show
   * rich per-result metadata.
   */
  renderItem?: (item: ComboboxItem<TId>) => React.ReactNode;
  /** Widen the panel and give the list more height (for rich `renderItem` rows). */
  wide?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");
  const [debouncedInput] = useDebouncedValue(inputValue, { wait: 300 });
  const listboxId = React.useId();

  // Use a ref to store the dialog and input elements
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Notify parent when search changes
  React.useEffect(() => {
    onSearchChange(debouncedInput);
  }, [debouncedInput, onSearchChange]);

  // Single open/close mutator: every transition (trigger click, Escape,
  // click-outside, item select, create-new) goes through this so `onOpenChange`
  // fires on EVERY change, honoring its "opens or closes" contract. It's
  // synchronous (not a post-paint effect) so an async-search wrapper's
  // `setActivated(true)` batches with the open render — the first painted frame
  // of the open dropdown already has the query enabled (loading spinner) instead
  // of flashing "No items found".
  const changeOpen = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  // Focus the input when the dropdown is opened
  React.useEffect(() => {
    if (open && inputRef.current) {
      // Use setTimeout to ensure DOM has updated
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [open]);

  // Handle click outside to close dropdown
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node) &&
        open
      ) {
        changeOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, changeOpen]);

  // Stop propagation to prevent dialog from capturing events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();

    // Close on escape
    if (e.key === "Escape") {
      changeOpen(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Container handles keyboard events for combobox dropdown
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={label}
        // Form-control trigger: hairline input chrome, not the outline button's
        // elevated treatment, so forms stay quiet.
        className="w-full min-w-[200px] justify-between truncate border border-border bg-input/20 font-normal font-sans shadow-none hover:bg-input/30 active:shadow-none max-sm:h-10"
        onClick={(e) => {
          // Prevent the click from bubbling up to the form and triggering a submit
          e.preventDefault();
          e.stopPropagation();
          changeOpen(!open);
        }}
        // Prevent form submission when clicking the button
        type="button"
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value?.name ?? `Select ${label}…`}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>

      {open && (
        <div
          className={cn(
            "fade-in-0 zoom-in-95 absolute z-[200] mt-1 w-full min-w-[200px] animate-in rounded-md border bg-popover shadow-md",
            wide
              ? "max-w-[400px] sm:w-[480px] sm:max-w-[520px]"
              : "max-w-[400px]",
          )}
        >
          <Row align="center" gap="sm" className="h-9 border-b px-2">
            <input
              ref={inputRef}
              className="flex h-10 w-full rounded-md bg-transparent py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={`Search ${label}...`}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                // Don't let events bubble up to dialog
                e.stopPropagation();
              }}
            />
          </Row>

          <div
            id={listboxId}
            role="listbox"
            className={cn(
              "overflow-y-auto",
              wide ? "max-h-[420px]" : "max-h-[300px]",
            )}
          >
            {isLoading ? (
              <SimpleLoading />
            ) : items.length === 0 ? (
              <div className="px-2 py-6 text-left text-sm">
                No {label} found.
                {onCreateNew && inputValue.trim() !== "" && (
                  <Button
                    variant="outline"
                    type="button" // Explicitly mark as a button type to prevent form submission
                    className="mt-2 w-full justify-start text-left"
                    onClick={async (e) => {
                      // Prevent form submission
                      e.preventDefault();
                      e.stopPropagation();

                      const newItem = await onCreateNew(inputValue);
                      setValue(newItem);
                      changeOpen(false);
                      setInputValue("");
                    }}
                  >
                    <span className="truncate">
                      Create new {label}: {inputValue}
                    </span>
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-hidden p-1">
                {items.map((result) => (
                  <Button
                    key={result.id}
                    variant="ghost"
                    type="button" // Explicitly mark as a button type to prevent form submission
                    className={cn(
                      "relative flex w-full cursor-default justify-start rounded-sm px-2 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                      renderItem
                        ? "h-auto items-start whitespace-normal py-2"
                        : "items-center",
                      value?.id === result.id &&
                        "bg-accent text-accent-foreground",
                    )}
                    onClick={(e) => {
                      // Prevent form submission
                      e.preventDefault();
                      e.stopPropagation();

                      if (result.id === value?.id) {
                        setValue(null);
                      } else {
                        setValue(result);
                      }
                      changeOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 flex-shrink-0",
                        renderItem &&
                          "mt-0.5" /* tight: check icon optical-align */,
                        value?.id === result.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {renderItem ? (
                      <span className="min-w-0 flex-1">
                        {renderItem(result)}
                      </span>
                    ) : (
                      <span className="flex-1 truncate">{result.name}</span>
                    )}
                    {result.icon && (
                      <span className="ml-1 shrink-0">{result.icon}</span>
                    )}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
