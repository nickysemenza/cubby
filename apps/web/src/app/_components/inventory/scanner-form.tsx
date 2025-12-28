/**
 * ScannerForm - Rapid inventory entry via barcode scanning or text search.
 *
 * Features:
 * - Misc checkbox: toggles "misc:" prefix, persists after submit for batch entry
 * - Smart input detection:
 *   - All digits (8-14 chars) → UPC lookup via findOrCreateByUPC
 *   - Any text → product search with dropdown, create new option
 * - Camera button for barcode scanning
 * - Recent items list showing items added this session
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import { Label } from "~/components/ui/label";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import type { LocationId, ProductId } from "~/schemas/identifiers";
import type { ProductTopLevelOut } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";
import { BarcodeScannerButton } from "./barcode-scanner-button";

interface ScannerFormProps {
  locationId: LocationId;
  locationName: string;
}

interface RecentItem {
  id: string;
  productName: string;
  timestamp: Date;
}

// Check if input looks like a UPC (8-14 digits only)
const isUpcInput = (input: string): boolean => {
  const trimmed = input.trim();
  return /^\d{8,14}$/.test(trimmed);
};

export function ScannerForm({ locationId, locationName }: ScannerFormProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const miscCheckboxId = useId();

  // Form state
  const [inputValue, setInputValue] = useState("");
  const [isMiscMode, setIsMiscMode] = useState(false);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Search query (applies misc prefix if checked)
  const searchQuery =
    isMiscMode && inputValue ? `misc:${inputValue}` : inputValue;

  // Product search query
  const { data: searchResults, isLoading: isSearching } = useQuery({
    ...api.product.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination: { pageIndex: 0, pageSize: 10 },
    }),
    enabled: inputValue.length > 0 && !isUpcInput(inputValue),
  });

  // UPC lookup mutation
  const findOrCreateByUPCMutation = useMutation(
    api.product.findOrCreateByUPC.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
      },
    }),
  );

  // Quick create product mutation
  const quickCreateMutation = useMutation(
    api.product.quickCreate.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
      },
    }),
  );

  // Inventory create mutation
  const createInventoryMutation = useMutation(
    api.inventoryItem.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: queryKeys.inventoryItem.list,
        });
      },
    }),
  );

  // Add item to inventory
  const addInventory = useCallback(
    async (productId: ProductId, productName: string) => {
      try {
        await createInventoryMutation.mutateAsync({
          productId,
          locationId,
          amount: { value: 1, unit: "each" },
        });

        // Add to recent items
        setRecentItems((prev) => [
          { id: crypto.randomUUID(), productName, timestamp: new Date() },
          ...prev.slice(0, 9), // Keep last 10
        ]);

        toast.success(`Added: ${productName}`);
        setInputValue("");
        setIsDropdownOpen(false);
        inputRef.current?.focus();
      } catch (error) {
        toast.error(`Failed to add: ${getErrorMessage(error)}`);
      }
    },
    [createInventoryMutation, locationId],
  );

  // Handle UPC scan (from camera or typed)
  const handleUpcScan = useCallback(
    async (upc: string) => {
      try {
        const product = await findOrCreateByUPCMutation.mutateAsync({ upc });
        await addInventory(product.id, product.name);
      } catch (error) {
        toast.error(`UPC lookup failed: ${getErrorMessage(error)}`);
      }
    },
    [findOrCreateByUPCMutation, addInventory],
  );

  // Handle selecting an existing product
  const handleSelectProduct = useCallback(
    async (product: ProductTopLevelOut) => {
      await addInventory(product.id, product.name);
    },
    [addInventory],
  );

  // Handle creating a new product
  const handleCreateNew = useCallback(async () => {
    const productName = isMiscMode ? `misc:${inputValue}` : inputValue;
    try {
      const product = await quickCreateMutation.mutateAsync({
        name: productName,
      });
      await addInventory(product.id, product.name);
    } catch (error) {
      toast.error(`Failed to create product: ${getErrorMessage(error)}`);
    }
  }, [isMiscMode, inputValue, quickCreateMutation, addInventory]);

  // Handle input change
  const handleInputChange = (value: string) => {
    setInputValue(value);
    if (value.length > 0 && !isUpcInput(value)) {
      setIsDropdownOpen(true);
    } else {
      setIsDropdownOpen(false);
    }
  };

  // Handle Enter key for UPC submission
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && isUpcInput(inputValue)) {
        e.preventDefault();
        handleUpcScan(inputValue.trim());
      }
    },
    [inputValue, handleUpcScan],
  );

  // Handle barcode scan from camera
  const handleBarcodeScan = useCallback(
    (barcode: string) => {
      handleUpcScan(barcode);
    },
    [handleUpcScan],
  );

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isPending =
    findOrCreateByUPCMutation.isPending ||
    quickCreateMutation.isPending ||
    createInventoryMutation.isPending;

  const displayName =
    isMiscMode && inputValue ? `misc:${inputValue}` : inputValue;

  return (
    <div className="space-y-4">
      {/* Location indicator */}
      <div className="text-muted-foreground text-sm">
        Adding to:{" "}
        <span className="font-medium text-foreground">{locationName}</span>
      </div>

      {/* Misc checkbox */}
      <div className="flex items-center space-x-2">
        <Checkbox
          id={miscCheckboxId}
          checked={isMiscMode}
          onCheckedChange={(checked) => setIsMiscMode(checked === true)}
        />
        <Label htmlFor={miscCheckboxId} className="text-sm">
          Misc (collection) — opaque items without detailed info
        </Label>
      </div>

      {/* Input with camera button */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Command className="rounded-lg border" shouldFilter={false}>
            <CommandInput
              ref={inputRef}
              placeholder={
                isMiscMode
                  ? "Type item name (misc: will be added)..."
                  : "Scan UPC or type product name..."
              }
              value={inputValue}
              onValueChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={isPending}
            />
            {isDropdownOpen && inputValue && !isUpcInput(inputValue) && (
              <CommandList>
                {isSearching ? (
                  <CommandEmpty>Searching...</CommandEmpty>
                ) : searchResults?.items.length === 0 ? (
                  <CommandEmpty>No products found</CommandEmpty>
                ) : (
                  <CommandGroup heading="Products">
                    {searchResults?.items.map((product) => (
                      <CommandItem
                        key={product.id}
                        value={product.id}
                        onSelect={() => handleSelectProduct(product)}
                        className="cursor-pointer"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        {product.name} ({product.manufacturer})
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={handleCreateNew}
                    className="cursor-pointer"
                    disabled={quickCreateMutation.isPending}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create &quot;{displayName}&quot;
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            )}
          </Command>
        </div>

        <BarcodeScannerButton
          onScan={handleBarcodeScan}
          disabled={isPending}
          size="default"
          className="h-10"
        />
      </div>

      {/* Hint text */}
      <p className="text-muted-foreground text-xs">
        {isUpcInput(inputValue)
          ? "Press Enter to look up UPC"
          : "Type to search products, or scan a barcode"}
      </p>

      {/* Recent items */}
      {recentItems.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-sm">Recently Added</h4>
          <div className="space-y-1">
            {recentItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 text-muted-foreground text-sm"
              >
                <Check className="h-3 w-3 text-green-500" />
                {item.productName}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
