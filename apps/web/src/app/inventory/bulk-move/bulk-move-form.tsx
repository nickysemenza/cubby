"use client";
import { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { ComboboxItem as ComboboxItemSchema } from "~/app/_components/combobox/combobox-types";
import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ArrowRight, Package } from "lucide-react";
import { toast } from "sonner";
import { type LocationId, type InventoryId } from "~/schemas/identifiers";
import { useRouter, useSearchParams } from "next/navigation";

import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ComboboxFieldWithSearch,
  FormWrapper,
} from "~/app/_components/form-utils";
import { type BulkMoveItem } from "~/schemas/inventory";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";

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
  sourceLocation: ComboboxItemSchema.nullable(),
  targetLocation: ComboboxItemSchema.nullable(),
});

type BulkMoveFormValues = z.infer<typeof formSchema>;

export default function BulkMoveForm() {
  const api = useTRPC();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveItems, setMoveItems] = useState<MoveItem[]>([]);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Initialize the form
  const form = useForm<BulkMoveFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sourceLocation: null,
      targetLocation: null,
    },
  });

  // Watch the location fields
  // eslint-disable-next-line react-hooks/incompatible-library -- React Hook Form API limitation
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
      const params = new URLSearchParams(searchParams.toString());
      params.set("sourceLocationId", sourceLocation.id);
      router.push(`/inventory/bulk-move?${params.toString()}`);
    }
  }, [sourceLocation, router, searchParams]);

  // Set initial source location from URL
  useEffect(() => {
    const locationId = searchParams.get("sourceLocationId");
    if (locationId && locations.length > 0) {
      const location = locations.find((loc) => loc.id === locationId);
      if (location) {
        form.setValue("sourceLocation", buildLocationComboboxItem(location));
      }
    }
  }, [searchParams, locations, form]);

  // Fetch inventory items from source location
  const { data: inventoryItemsData, refetch: refetchInventoryItems } = useQuery(
    api.inventoryItem.list.queryOptions(
      {
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: { pageIndex: 0, pageSize: 100 },
        filters: { locationIdFilter: sourceLocation?.id },
      },
      {
        enabled: !!sourceLocation,
      },
    ),
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
    api.inventoryItem.bulkMove.mutationOptions({
      onSuccess: () => {
        refetchInventoryItems();
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
        inventoryEntryId: item.inventoryEntryId as InventoryId,
        quantity: {
          value: item.moveQuantity,
          unit: item.unit,
        },
      }));

      await bulkMoveMutation.mutateAsync({
        sourceLocationId: values.sourceLocation.id as LocationId,
        targetLocationId: values.targetLocation.id as LocationId,
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
    >
      {/* Location selectors */}
      <div className="mb-6 flex items-end gap-4">
        <div className="flex-1">
          <ComboboxFieldWithSearch
            form={form}
            name="sourceLocation"
            label="From Location"
            searchType="location"
          />
        </div>
        <ArrowRight className="text-muted-foreground mb-2 h-6 w-6" />
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
            <h3 className="text-lg font-medium">
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
              <div className="text-muted-foreground flex items-center gap-4 border-b pb-2 text-sm font-medium">
                <div className="w-8"></div>
                <div className="flex-1">Product</div>
                <div className="w-32 text-right">Available</div>
                <div className="w-40">Move Quantity</div>
              </div>

              {/* Items */}
              {moveItems.map((item, index) => (
                <div
                  key={item.inventoryEntryId}
                  className={`flex items-center gap-4 rounded border p-3 ${
                    item.selected ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <Checkbox
                    checked={item.selected}
                    onCheckedChange={() => toggleItemSelection(index)}
                  />
                  <div className="flex flex-1 items-center gap-2">
                    <Package className="text-muted-foreground h-4 w-4" />
                    <span className="font-medium">{item.productName}</span>
                  </div>
                  <div className="text-muted-foreground w-32 text-right">
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
            <div className="text-muted-foreground py-8 text-center">
              No inventory items at this location.
            </div>
          )}

          {/* Selection summary */}
          {selectedItems.length > 0 && (
            <div className="bg-muted mt-4 rounded-lg p-4">
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
