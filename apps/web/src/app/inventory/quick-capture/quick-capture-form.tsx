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

import type { ProductId } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Plus,
  ScanBarcode,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  buildLocationComboboxItem,
  buildProductComboboxItem,
} from "~/app/_components/combobox/combobox-builders";
import { WithProductSearch } from "~/app/_components/combobox/with-search-hook";
import { EntityPillLink } from "~/app/_components/EntityPill";
import {
  getOptionalLocationId,
  getProductId,
  inventoryItemWithLocationFields,
} from "~/app/_components/form-fields";
import {
  ComboboxField,
  ComboboxFieldWithSearch,
  FormWrapper,
  getSubmitButtonText,
} from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { BarcodeScannerButton } from "~/app/_components/inventory/barcode-scanner-button";
import { useUpcLookup } from "~/app/_components/inventory/hooks";
import {
  BARCODE_FORMATS,
  PersistentScanner,
} from "~/app/_components/inventory/persistent-scanner";
import { RecentLocations } from "~/app/_components/inventory/recent-locations";
import {
  LocationBreadcrumb,
  locationToSegments,
} from "~/app/_components/locations/location-breadcrumb";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Empty, EmptyTitle } from "~/components/ui/empty";
import { Kbd } from "~/components/ui/kbd";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { EntityIcon } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

// Schema for the entire form using shared field schema
const quickCaptureFormSchema = z.object({
  items: z.array(inventoryItemWithLocationFields),
});

type QuickCaptureFormValues = z.input<typeof quickCaptureFormSchema>;

interface RecentScanItem {
  id: string;
  productName: string;
  timestamp: Date;
}

interface QuickCaptureFormProps {
  initialLocationId?: string;
  initialProductId?: string;
  /** Start with persistent scanner mode enabled */
  initialScannerMode?: boolean;
}

export default function QuickCaptureForm({
  initialLocationId,
  initialProductId,
  initialScannerMode = false,
}: QuickCaptureFormProps) {
  const api = useTRPC();
  const scannerToggleId = useId();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedRowIndex, setFocusedRowIndex] = useState(0);
  const [showInventory, setShowInventory] = useState(true);
  const [scannerEnabled, setScannerEnabled] = useState(initialScannerMode);
  const [recentScans, setRecentScans] = useState<RecentScanItem[]>([]);
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
  const focusedLocationId = getOptionalLocationId(focusedItem?.location);

  // Fetch initial location if provided
  const { data: initialLocation } = useQuery({
    ...api.location.getByID.queryOptions({
      id: initialLocationId!,
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

  // Fetch initial product if provided
  const { data: initialProduct } = useQuery({
    ...api.product.getByID.queryOptions({
      id: initialProductId!,
    }),
    enabled: !!initialProductId,
  });

  // Set initial product when loaded
  useEffect(() => {
    if (initialProduct && items[0]?.product === null) {
      form.setValue(
        "items.0.product",
        buildProductComboboxItem(initialProduct),
      );
    }
  }, [initialProduct, form, items]);

  // Fetch focused location with hierarchy for breadcrumbs
  const { data: focusedLocation, isLoading: isLoadingFocusedLocation } =
    useQuery({
      ...api.location.getByID.queryOptions({ id: focusedLocationId! }),
      enabled: !!focusedLocationId,
    });

  // Fetch inventory at focused location
  const { data: inventoryAtLocation } = useQuery({
    ...api.inventory.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 20 },
      filters: { locationIdFilter: focusedLocationId ?? "" },
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
    api.inventory.bulkProcess.mutationOptions({
      onSuccess: () => {
        // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({
          queryKey: [queryKeys.inventory.list],
        });
        // Persisted per-location valuations were recomputed server-side.
        queryClient.invalidateQueries({ queryKey: [queryKeys.location.all] });
      },
    }),
  );

  // Find or create product by UPC
  const findOrCreateByUPCMutation = useMutation(
    api.product.findOrCreateByUPC.mutationOptions({
      onSuccess: () => {
        // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({ queryKey: [queryKeys.product.list] });
      },
    }),
  );

  // Handle barcode scan for a specific item index (row scanner button)
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
        const errorMessage = getErrorMessage(err);
        console.error(`[Barcode Scan] Failed for ${barcode}:`, errorMessage);
        toast.error(`Failed to look up barcode: ${errorMessage}`);
      }
    },
    [findOrCreateByUPCMutation, form],
  );

  // Inventory create mutation for persistent scanner mode
  const createInventoryMutation = useMutation(
    api.inventory.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: [queryKeys.inventory.list],
        });
        queryClient.invalidateQueries({ queryKey: [queryKeys.location.all] });
      },
    }),
  );

  // UPC lookup for persistent scanner
  const { lookupUpc, isPending: isUpcPending } = useUpcLookup();

  // Handle persistent scanner barcode scan (directly creates inventory)
  const handlePersistentScan = useCallback(
    async (barcode: string) => {
      const focusedItem = items[focusedRowIndex];
      const locationId = getOptionalLocationId(focusedItem?.location);

      if (!locationId) {
        toast.error("Select a location first");
        return;
      }

      const product = await lookupUpc(barcode);
      if (!product) return;

      try {
        await createInventoryMutation.mutateAsync({
          productId: product.id,
          locationId,
          amount: { value: 1, unit: "each" },
        });

        // Add to recent scans
        setRecentScans((prev) => [
          {
            id: crypto.randomUUID(),
            productName: product.name,
            timestamp: new Date(),
          },
          ...prev.slice(0, 9),
        ]);

        toast.success(`Added: ${product.name}`);
      } catch (err) {
        toast.error(`Failed to add: ${getErrorMessage(err)}`);
      }
    },
    [items, focusedRowIndex, lookupUpc, createInventoryMutation],
  );

  const isScannerPending = isUpcPending || createInventoryMutation.isPending;

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
          const locationId = getOptionalLocationId(item.location)!;
          if (!itemsByLocation.has(locationId)) {
            itemsByLocation.set(locationId, []);
          }
          itemsByLocation.get(locationId)!.push({
            productId: getProductId(item.product),
            amount: item.amount,
          });
        }

        // Process each location's items
        for (const [locationId, locationItems] of itemsByLocation) {
          await bulkProcessMutation.mutateAsync({
            locationId,
            items: locationItems.map((item) => ({
              locationId,
              productId: item.productId,
              amount: item.amount,
            })),
          });
        }

        // Get unique location names for success message
        const locationNames = uniq(
          validItems.map((item) => item.location.name),
        );
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
      submitButtonText={getSubmitButtonText("create")}
      stickyFooter
      footerStart={
        <span className="truncate font-mono text-2xs text-muted-foreground uppercase tabular-nums">
          {fields.length} item{fields.length === 1 ? "" : "s"} ready
        </span>
      }
    >
      {/* Persistent Scanner Mode Toggle */}
      <Card className="mb-4">
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch
                id={scannerToggleId}
                checked={scannerEnabled}
                onCheckedChange={setScannerEnabled}
              />
              <Label
                htmlFor={scannerToggleId}
                className="flex items-center gap-2"
              >
                <ScanBarcode className="h-4 w-4" />
                Persistent Scanner
              </Label>
            </div>
            {scannerEnabled && !focusedLocationId && (
              <span className="text-muted-foreground text-sm">
                Select a location below first
              </span>
            )}
          </div>

          {/* Persistent Scanner */}
          {scannerEnabled && focusedLocationId && (
            <div className="mt-4 space-y-2">
              <PersistentScanner
                onScan={handlePersistentScan}
                enabled={!isScannerPending}
                formatsToSupport={BARCODE_FORMATS}
                scanHintText="Point at barcode to scan"
              />

              {/* Loading indicator */}
              {isScannerPending && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
                  <Spinner />
                  Looking up product...
                </div>
              )}

              {/* Recent scans */}
              {recentScans.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Recently Scanned</h4>
                  <div className="flex flex-wrap gap-2">
                    {recentScans.slice(0, 5).map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 rounded-full bg-positive/10 px-2 py-1 text-positive text-xs"
                      >
                        <Check className="h-3 w-3" />
                        <span className="max-w-[120px] truncate">
                          {item.productName}
                        </span>
                      </div>
                    ))}
                    {recentScans.length > 5 && (
                      <span className="px-2 py-1 text-muted-foreground text-xs">
                        +{recentScans.length - 5} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Location Context Section */}
      {focusedLocationId ? (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle>Current Location Context</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoadingFocusedLocation ? (
              <div className="flex items-center justify-center py-4">
                <Spinner />
              </div>
            ) : focusedLocation ? (
              <>
                {/* Breadcrumb navigation */}
                <LocationBreadcrumb
                  segments={locationToSegments(focusedLocation)}
                  linkable
                  showHome
                />

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
                            size="default"
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
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-4">
          <CardContent className="pt-4">
            <RecentLocations
              onSelect={(location) => {
                form.setValue(
                  `items.${focusedRowIndex}.location`,
                  buildLocationComboboxItem(location),
                  { shouldDirty: true },
                );
              }}
            />
          </CardContent>
        </Card>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-medium text-lg">
          {scannerEnabled ? "Manual Entry" : "Add Items"}
        </h3>
        <Button type="button" onClick={addInventoryItem} size="sm">
          <Plus className="mr-1 h-4 w-4" />
          Add Row <Kbd className="ml-1">Ctrl+N</Kbd>
        </Button>
      </div>

      <div className="space-y-2">
        {fields.map((field, index) => {
          const isFocused = index === focusedRowIndex;

          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: Form row focus tracking for visual feedback
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
              <div className="flex items-center gap-2">
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
              <CardTitle>
                <EntityIcon entity="inventory" className="h-4 w-4" />
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
                      <EntityPillLink entity="product" data={item.product} />
                      <span className="text-muted-foreground text-xs">
                        ({item.amount.value} {item.amount.unit})
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty className="border-none py-2">
                  <EmptyTitle>No items at this location yet</EmptyTitle>
                </Empty>
              )}
            </CardContent>
          )}
        </Card>
      )}

      <div className="mt-4 text-muted-foreground text-sm">
        <p>Keyboard shortcuts:</p>
        <ul className="list-inside list-disc">
          <li>
            <Kbd>Ctrl+Enter</Kbd> - Save all items
          </li>
          <li>
            <Kbd>Ctrl+N</Kbd> - Add new item (copies location from above)
          </li>
          <li>
            <Kbd>Tab</Kbd> - Navigate fields
          </li>
        </ul>
      </div>
    </FormWrapper>
  );
}
