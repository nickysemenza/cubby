/**
 * BulkMoveForm - Full-page workflow for moving inventory between locations.
 *
 * Use this component when:
 * - User needs to select both source and target locations
 * - Moving multiple items with partial quantity support (e.g., move 5 of 10)
 * - Need select-all/deselect-all functionality for bulk selection
 * - Full visibility of what's being moved with editable quantities
 *
 * For quick moves from a known location where source is already established,
 * use the lighter-weight MoveInventoryDialog instead.
 *
 * @see MoveInventoryDialog - Lightweight modal for quick moves
 */

import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import type { BulkMoveItem } from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  getLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import {
  ComboboxFieldWithSearch,
  FormWrapper,
} from "~/app/_components/form-utils";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { EntityIcon } from "~/entities/entities";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

type InventoryWithLocationAndProductOut = z.infer<
  typeof inventoryWithLocationAndProductOut
>;

// Type for an item to move
interface MoveItem {
  inventoryEntryId: string;
  productName: string;
  currentQuantity: number;
  moveQuantity: number;
  unit: string;
  selected: boolean;
}

// Schema for the form
const formSchema = z.object({
  sourceLocation: optionalLocationField,
  targetLocation: optionalLocationField,
});

type BulkMoveFormValues = z.infer<typeof formSchema>;

export default function BulkMoveForm() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveItems, setMoveItems] = useState<MoveItem[]>([]);
  const navigate = useNavigate();

  // Initialize the form
  const form = useForm<BulkMoveFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sourceLocation: null,
      targetLocation: null,
    },
  });

  // Watch the location fields
  const sourceLocation = form.watch("sourceLocation");
  const targetLocation = form.watch("targetLocation");

  // Fetch locations for the selectors
  const { data: locationsResp } = useQuery(
    api.location.list.queryOptions({
      pagination: { pageIndex: 0, pageSize: 100 },
      sort: { orderBy: "name", direction: "asc" },
      filters: {},
    }),
  );

  const locations = useMemo(() => locationsResp?.items || [], [locationsResp]);

  // Update URL when source location changes
  useEffect(() => {
    if (sourceLocation) {
      const params = new URLSearchParams(window.location.search);
      params.set("sourceLocationId", sourceLocation.id);
      navigate({ to: `/inventory/bulk-move?${params.toString()}` });
    }
  }, [sourceLocation, navigate]);

  // Set initial source location from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const locationId = params.get("sourceLocationId");
    if (locationId && locations.length > 0) {
      const location = locations.find((loc) => loc.id === locationId);
      if (location) {
        form.setValue("sourceLocation", buildLocationComboboxItem(location));
      }
    }
  }, [locations, form]);

  // Fetch inventory items from source location
  const { data: inventoryItemsData, refetch: refetchInventoryItems } = useQuery(
    {
      ...api.inventory.list.queryOptions({
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: { pageIndex: 0, pageSize: 100 },
        filters: { locationIdFilter: sourceLocation?.id ?? "" },
      }),
      enabled: !!sourceLocation,
    },
  );

  // Build move items list when inventory data changes
  useEffect(() => {
    if (sourceLocation && inventoryItemsData?.items) {
      const items: MoveItem[] = inventoryItemsData.items.map(
        (item: InventoryWithLocationAndProductOut) => ({
          inventoryEntryId: item.id,
          productName: item.product.name,
          currentQuantity: item.amount.value,
          moveQuantity: item.amount.value, // Default to full quantity
          unit: item.amount.unit,
          selected: false,
        }),
      );
      setMoveItems(items);
    } else {
      setMoveItems([]);
    }
  }, [sourceLocation, inventoryItemsData]);

  // Toggle item selection
  const toggleItemSelection = (index: number) => {
    setMoveItems((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, selected: !item.selected } : item,
      ),
    );
  };

  // Select/deselect all
  const toggleSelectAll = () => {
    const allSelected = moveItems.every((item) => item.selected);
    setMoveItems((prev) =>
      prev.map((item) => ({ ...item, selected: !allSelected })),
    );
  };

  // Update move quantity for an item
  const updateMoveQuantity = (index: number, quantity: number) => {
    setMoveItems((prev) =>
      prev.map((item, i) =>
        i === index
          ? { ...item, moveQuantity: Math.min(quantity, item.currentQuantity) }
          : item,
      ),
    );
  };

  // Get selected items
  const selectedItems = moveItems.filter((item) => item.selected);

  // Bulk move mutation
  const bulkMoveMutation = useMutation(
    api.inventory.bulkMove.mutationOptions({
      onSuccess: () => {
        refetchInventoryItems();
        // Refresh persisted location valuations (recomputed server-side).
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.location.all],
        });
      },
    }),
  );

  // Submit handler
  const onSubmit = async (values: BulkMoveFormValues) => {
    if (!values.sourceLocation) {
      setError("Please select a source location");
      return;
    }
    if (!values.targetLocation) {
      setError("Please select a target location");
      return;
    }
    if (values.sourceLocation.id === values.targetLocation.id) {
      setError("Source and target locations must be different");
      return;
    }
    if (selectedItems.length === 0) {
      setError("Please select at least one item to move");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const items: BulkMoveItem[] = selectedItems.map((item) => ({
        inventoryEntryId: unsafeInventoryId(item.inventoryEntryId),
        quantity: {
          value: item.moveQuantity,
          unit: item.unit,
        },
      }));

      await bulkMoveMutation.mutateAsync({
        sourceLocationId: getLocationId(values.sourceLocation),
        targetLocationId: getLocationId(values.targetLocation),
        items,
      });

      toast.success(
        `Successfully moved ${selectedItems.length} item(s) to ${values.targetLocation.name}`,
      );

      // Clear selections after successful move
      setMoveItems((prev) =>
        prev.map((item) => ({ ...item, selected: false })),
      );
      setIsSubmitting(false);
    } catch (err) {
      console.error("Error moving inventory items:", err);
      setError("Failed to move inventory items. Please try again.");
      setIsSubmitting(false);
    }
  };

  return (
    <FormWrapper
      form={form}
      onSubmit={onSubmit}
      error={error ?? undefined}
      isPending={isSubmitting}
      submitButtonText={
        isSubmitting
          ? "Moving..."
          : `Move ${selectedItems.length} Item${selectedItems.length !== 1 ? "s" : ""}`
      }
      stickyFooter
      footerStart={
        <span className="truncate font-mono text-2xs text-muted-foreground uppercase tabular-nums">
          {selectedItems.length} selected
        </span>
      }
    >
      {/* Location selectors */}
      <div className="mb-4 flex items-end gap-4">
        <div className="flex-1">
          <ComboboxFieldWithSearch
            form={form}
            name="sourceLocation"
            label="From Location"
            searchType="location"
          />
        </div>
        <ArrowRight className="mb-2 h-6 w-6 text-muted-foreground" />
        <div className="flex-1">
          <ComboboxFieldWithSearch
            form={form}
            name="targetLocation"
            label="To Location"
            searchType="location"
          />
        </div>
      </div>

      {/* Items list */}
      {sourceLocation && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-medium text-lg">
              Items at {sourceLocation.name}
            </h3>
            {moveItems.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={toggleSelectAll}
              >
                {moveItems.every((item) => item.selected)
                  ? "Deselect All"
                  : "Select All"}
              </Button>
            )}
          </div>

          {moveItems.length > 0 ? (
            <div className="space-y-2">
              {/* Header */}
              <div className="flex items-center gap-4 border-b pb-2 font-medium text-muted-foreground text-sm">
                <div className="w-8"></div>
                <div className="flex-1">Product</div>
                <div className="w-32 text-right">Available</div>
                <div className="w-40">Move Quantity</div>
              </div>

              {/* Items */}
              {moveItems.map((item, index) => (
                <div
                  key={item.inventoryEntryId}
                  className={`flex items-center gap-4 rounded border p-4 ${
                    item.selected ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <Checkbox
                    checked={item.selected}
                    onCheckedChange={() => toggleItemSelection(index)}
                  />
                  <div className="flex flex-1 items-center gap-2">
                    <EntityIcon
                      entity="inventory"
                      className="h-4 w-4 text-muted-foreground"
                    />
                    <span className="font-medium">{item.productName}</span>
                  </div>
                  <div className="w-32 text-right text-muted-foreground">
                    {item.currentQuantity} {item.unit}
                  </div>
                  <div className="flex w-40 items-center gap-2">
                    <Input
                      type="number"
                      min={0.01}
                      max={item.currentQuantity}
                      step="any"
                      value={item.moveQuantity}
                      onChange={(e) =>
                        updateMoveQuantity(
                          index,
                          parseFloat(e.target.value) || 0,
                        )
                      }
                      className="w-20"
                      disabled={!item.selected}
                    />
                    <span className="text-muted-foreground text-sm">
                      {item.unit}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-muted-foreground">
              No inventory items at this location.
            </div>
          )}

          {/* Selection summary */}
          {selectedItems.length > 0 && (
            <div className="mt-4 rounded-lg bg-muted p-4">
              <h4 className="mb-2 font-medium">Move Summary</h4>
              <p className="text-muted-foreground text-sm">
                {selectedItems.length} item
                {selectedItems.length !== 1 ? "s" : ""} selected
                {targetLocation && (
                  <>
                    {" "}
                    to move to{" "}
                    <span className="font-medium">{targetLocation.name}</span>
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </FormWrapper>
  );
}
