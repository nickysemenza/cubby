/**
 * QuickCaptureForm - Full-featured rapid entry form for inventory data capture.
 *
 * Use this component when:
 * - Rapid multi-item data entry (e.g., inventorying a shelf)
 * - Need barcode scanner integration for product lookup
 * - Want keyboard shortcuts (Ctrl+Enter to submit, Ctrl+N to add row)
 * - Need location context with breadcrumbs and quick navigation to child locations
 * - Want to see existing inventory at the focused location
 * - Auto-copying location from previous row for efficiency
 *
 * For simple single-item additions embedded within a page,
 * use the lighter-weight QuickInventoryAdd component instead.
 *
 * @see QuickInventoryAdd - Compact inline form for single items
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "~/app/_components/combobox/combobox-builders";
import { Button } from "~/components/ui/button";
import { X, Plus, ChevronDown, ChevronUp, Package } from "lucide-react";
import { toast } from "sonner";
import { type LocationId, type ProductId } from "~/schemas/identifiers";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  ComboboxFieldWithSearch,
  FormWrapper,
  getSubmitButtonText,
} from "~/app/_components/form-utils";
import { queryKeys } from "~/lib/query-keys";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { WithProductSearch } from "~/app/_components/combobox/with-search-hook";
import { ComboboxField } from "~/app/_components/form-utils";
import { BarcodeScannerButton } from "~/app/_components/inventory/barcode-scanner-button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { EnhancedBreadcrumbs } from "~/app/_components/locations/enhanced-breadcrumbs";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { ProductPillLink } from "~/app/_components/EntityPill";
import { type InfLocation } from "~/schemas/location";
import { inventoryItemWithLocationFields } from "~/schemas/form-fields";

// Schema for the entire form using shared field schema
const quickCaptureFormSchema = z.object({
  items: z.array(inventoryItemWithLocationFields),
});

type QuickCaptureFormValues = z.infer<typeof quickCaptureFormSchema>;

interface QuickCaptureFormProps {
  initialLocationId?: string;
}

export default function QuickCaptureForm({
  initialLocationId,
}: QuickCaptureFormProps) {
  const api = useTRPC();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedRowIndex, setFocusedRowIndex] = useState(0);
  const [showInventory, setShowInventory] = useState(true);
  const queryClient = useQueryClient();

  // Initialize the form
  const form = useForm<QuickCaptureFormValues>({
    resolver: zodResolver(quickCaptureFormSchema),
    defaultValues: {
      items: [
        {
          location: null,
          product: null,
          amount: { value: 1, unit: "each" },
        },
      ],
    },
  });

  // Set up the field array for inventory items
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Watch items to get the last location for copying and focused location
  const items = form.watch("items");
  const focusedItem = items[focusedRowIndex];
  const focusedLocationId = focusedItem?.location?.id as LocationId | undefined;

  // Fetch initial location if provided
  const { data: initialLocation } = useQuery({
    ...api.location.getByID.queryOptions({
      id: initialLocationId as LocationId,
    }),
    enabled: !!initialLocationId,
  });

  // Set initial location when loaded
  useEffect(() => {
    if (initialLocation && items[0]?.location === null) {
      form.setValue(
        "items.0.location",
        buildLocationComboboxItem(initialLocation),
      );
    }
  }, [initialLocation, form, items]);

  // Fetch focused location with hierarchy for breadcrumbs
  const { data: focusedLocation } = useQuery({
    ...api.location.getByID.queryOptions({ id: focusedLocationId! }),
    enabled: !!focusedLocationId,
  });

  // Fetch inventory at focused location
  const { data: inventoryAtLocation } = useQuery({
    ...api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 20 },
      filters: { locationIdFilter: focusedLocationId },
    }),
    enabled: !!focusedLocationId,
  });

  // Add a new empty inventory item, copying location from previous row
  const addInventoryItem = useCallback(() => {
    const lastItem = items[items.length - 1];
    const lastLocation = lastItem?.location ?? null;
    append({
      location: lastLocation,
      product: null,
      amount: { value: 1, unit: "each" },
    });
    // Focus the new row
    setFocusedRowIndex(items.length);
  }, [append, items]);

  // Handle clicking a child location to set it on the focused row
  const handleChildLocationClick = useCallback(
    (childLocation: InfLocation) => {
      form.setValue(
        `items.${focusedRowIndex}.location`,
        buildLocationComboboxItem(childLocation),
      );
    },
    [form, focusedRowIndex],
  );

  // Bulk process mutation
  const bulkProcessMutation = useMutation(
    api.inventoryItem.bulkProcess.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: queryKeys.inventoryItem.list,
        });
      },
    }),
  );

  // Find or create product by UPC
  const findOrCreateByUPCMutation = useMutation(
    api.product.findOrCreateByUPC.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
      },
    }),
  );

  // Handle barcode scan for a specific item index
  const handleBarcodeScan = useCallback(
    async (barcode: string, index: number) => {
      try {
        const product = await findOrCreateByUPCMutation.mutateAsync({
          upc: barcode,
        });
        form.setValue(
          `items.${index}.product`,
          buildProductComboboxItem(product),
        );
        toast.success(`Found: ${product.name}`);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        console.error(`[Barcode Scan] Failed for ${barcode}:`, errorMessage);
        toast.error(`Failed to look up barcode: ${errorMessage}`);
      }
    },
    [findOrCreateByUPCMutation, form],
  );

  // Submit handler
  const onSubmit = useCallback(
    async (values: QuickCaptureFormValues) => {
      setError(null);

      const validItems = values.items.filter(
        (
          item,
        ): item is typeof item & {
          location: NonNullable<typeof item.location>;
          product: NonNullable<typeof item.product>;
        } =>
          item.location !== null &&
          item.product !== null &&
          item.amount.value !== null &&
          item.amount.unit !== "",
      );

      if (validItems.length === 0) {
        setError("Please add at least one item with location and product");
        return;
      }

      setIsSubmitting(true);
      try {
        // Group items by location for efficient processing
        const itemsByLocation = new Map<
          string,
          Array<{
            productId: ProductId;
            amount: { value: number; unit: string };
          }>
        >();

        for (const item of validItems) {
          const locationId = item.location.id;
          if (!itemsByLocation.has(locationId)) {
            itemsByLocation.set(locationId, []);
          }
          itemsByLocation.get(locationId)!.push({
            productId: item.product.id as ProductId,
            amount: item.amount,
          });
        }

        // Process each location's items
        for (const [locationId, locationItems] of itemsByLocation) {
          await bulkProcessMutation.mutateAsync({
            locationId: locationId as LocationId,
            items: locationItems.map((item) => ({
              locationId: locationId as LocationId,
              productId: item.productId,
              amount: item.amount,
            })),
          });
        }

        // Get unique location names for success message
        const locationNames = [
          ...new Set(validItems.map((item) => item.location.name)),
        ];
        const locationText =
          locationNames.length === 1
            ? locationNames[0]
            : `${locationNames.length} locations`;

        toast.success(
          `Successfully added ${validItems.length} item(s) to ${locationText}`,
        );

        // Reset form, keeping the last location for convenience
        const lastLocation =
          validItems[validItems.length - 1]?.location ?? null;
        form.setValue("items", [
          {
            location: lastLocation,
            product: null,
            amount: { value: 1, unit: "each" },
          },
        ]);
        setFocusedRowIndex(0);
      } catch (err) {
        console.error("Error submitting inventory items:", err);
        setError("Failed to update inventory. Please try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [bulkProcessMutation, form],
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Enter to submit
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        form.handleSubmit(onSubmit)();
      }
      // Ctrl/Cmd + N to add new item
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        addInventoryItem();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [form, addInventoryItem, onSubmit]);

  return (
    <FormWrapper
      form={form}
      onSubmit={onSubmit}
      error={error ?? undefined}
      isPending={isSubmitting}
      submitButtonText={getSubmitButtonText("create", isSubmitting)}
    >
      {/* Location Context Section */}
      {focusedLocation && (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Current Location Context
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Breadcrumb navigation */}
            <EnhancedBreadcrumbs location={focusedLocation} />

            {/* Children quick navigation */}
            {focusedLocation.children &&
              focusedLocation.children.length > 0 && (
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs">
                    Drill into child location:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {focusedLocation.children.map((child) => (
                      <Button
                        key={child.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleChildLocationClick(child)}
                      >
                        <LocationIcon
                          type={child.type}
                          size={12}
                          className="mr-1"
                        />
                        {child.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
          </CardContent>
        </Card>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-medium">Quick Inventory Capture</h3>
        <Button type="button" onClick={addInventoryItem} size="sm">
          <Plus className="mr-1 h-4 w-4" />
          Add Item (Ctrl+N)
        </Button>
      </div>

      <div className="space-y-2">
        {fields.map((field, index) => {
          const isFocused = index === focusedRowIndex;

          return (
            <div
              key={field.id}
              className={`flex flex-col gap-2 rounded border p-2 transition-colors md:flex-row md:items-start ${
                isFocused ? "border-primary bg-primary/5" : ""
              }`}
              onFocus={() => setFocusedRowIndex(index)}
              onClick={() => setFocusedRowIndex(index)}
            >
              {/* Location field */}
              <div className="w-full shrink-0 md:w-48">
                <ComboboxFieldWithSearch
                  form={form}
                  name={`items.${index}.location`}
                  label={index === 0 ? "Location" : undefined}
                  searchType="location"
                />
              </div>

              {/* Product field with quick create */}
              <div className="w-1/2 min-w-0 flex-1">
                <WithProductSearch>
                  {({ items, onSearchChange, isLoading, onCreateNew }) => (
                    <ComboboxField
                      form={form}
                      name={`items.${index}.product`}
                      label={index === 0 ? "Product" : undefined}
                      items={items}
                      onSearchChange={onSearchChange}
                      isLoading={isLoading}
                      onCreateNew={onCreateNew}
                    />
                  )}
                </WithProductSearch>
              </div>

              {/* Amount field */}
              <div className="w-full flex-shrink-0 md:w-52">
                <AmountFieldGroup
                  form={form}
                  valuePath={`items.${index}.amount.value`}
                  unitPath={`items.${index}.amount.unit`}
                />
              </div>

              {/* Action buttons */}
              <div
                className={`flex items-center gap-2 ${index === 0 ? "md:mt-6" : ""}`}
              >
                <BarcodeScannerButton
                  onScan={(barcode) => handleBarcodeScan(barcode, index)}
                  disabled={findOrCreateByUPCMutation.isPending}
                />

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (fields.length > 1) {
                      remove(index);
                      if (focusedRowIndex >= fields.length - 1) {
                        setFocusedRowIndex(Math.max(0, focusedRowIndex - 1));
                      }
                    }
                  }}
                  disabled={fields.length <= 1}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Inventory at focused location */}
      {focusedLocationId && (
        <Card className="mt-4">
          <CardHeader className="pb-2">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left"
              onClick={() => setShowInventory(!showInventory)}
            >
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Package className="h-4 w-4" />
                Items at {focusedItem?.location?.name ?? "this location"} (
                {inventoryAtLocation?.meta?.totalCount ?? 0})
              </CardTitle>
              {showInventory ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          </CardHeader>
          {showInventory && (
            <CardContent>
              {inventoryAtLocation?.items &&
              inventoryAtLocation.items.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {inventoryAtLocation.items.map((item) => (
                    <div key={item.id} className="flex items-center gap-1">
                      <ProductPillLink product={item.product} />
                      <span className="text-muted-foreground text-xs">
                        ({item.amount.value} {item.amount.unit})
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No items at this location yet.
                </p>
              )}
            </CardContent>
          )}
        </Card>
      )}

      <div className="text-muted-foreground mt-4 text-sm">
        <p>Keyboard shortcuts:</p>
        <ul className="list-inside list-disc">
          <li>
            <kbd className="bg-muted rounded px-1">Ctrl+Enter</kbd> - Save all
            items
          </li>
          <li>
            <kbd className="bg-muted rounded px-1">Ctrl+N</kbd> - Add new item
            (copies location from above)
          </li>
          <li>
            <kbd className="bg-muted rounded px-1">Tab</kbd> - Navigate fields
          </li>
        </ul>
      </div>
    </FormWrapper>
  );
}
