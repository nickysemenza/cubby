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

import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import type {
  BulkMoveItem,
  inventoryListItemOut,
} from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import {
  DestinationLocationField,
  resolveDestination,
} from "~/app/_components/inventory/destination-location-picker";
import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import { Row, Stack } from "~/components/layout";
import { MutedBox } from "~/components/layout/muted-box";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { EntityIcon } from "~/entities/entities";
import { useTRPC } from "~/trpc/react";

type InventoryListItem = z.infer<typeof inventoryListItemOut>;

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

interface BulkMoveFormProps {
  initialSourceLocationId?: string;
}

export default function BulkMoveForm({
  initialSourceLocationId,
}: BulkMoveFormProps) {
  const api = useTRPC();
  const invalidateInventory = useInventoryInvalidation();
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
    if (sourceLocation && sourceLocation.id !== initialSourceLocationId) {
      navigate({
        to: "/inventory/bulk-move",
        search: { sourceLocationId: sourceLocation.id },
        replace: true,
      });
    }
  }, [sourceLocation, initialSourceLocationId, navigate]);

  // Set initial source location from URL
  useEffect(() => {
    if (
      initialSourceLocationId &&
      locations.length > 0 &&
      sourceLocation?.id !== initialSourceLocationId
    ) {
      const location = locations.find(
        (loc) => loc.id === initialSourceLocationId,
      );
      if (location) {
        form.setValue("sourceLocation", buildLocationComboboxItem(location));
      }
    }
  }, [initialSourceLocationId, locations, form, sourceLocation]);

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
        (item: InventoryListItem) => ({
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
      onSuccess: (data) => {
        refetchInventoryItems();
        invalidateInventory(data);
      },
    }),
  );

  // Submit handler
  const onSubmit = async (values: BulkMoveFormValues) => {
    if (!values.sourceLocation) {
      setError("Please select a source location");
      return;
    }
    const resolved = resolveDestination(
      values.targetLocation,
      getLocationId(values.sourceLocation),
      {
        missingTarget: "Please select a target location",
        sameAsSource: "Source and target locations must be different",
      },
    );
    if (!resolved.ok) {
      setError(resolved.error);
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
        targetLocationId: resolved.id,
        items,
      });

      toast.success(
        `Successfully moved ${selectedItems.length} item(s) to ${values.targetLocation?.name}`,
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
      <Row align="end" gap="md" className="mb-4">
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
          <DestinationLocationField
            form={form}
            name="targetLocation"
            label="To Location"
            error={null}
          />
        </div>
      </Row>

      {/* Items list */}
      {sourceLocation && (
        <div>
          <Row align="center" justify="between" className="mb-4">
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
          </Row>

          {moveItems.length > 0 ? (
            <Stack gap="sm">
              {/* Header */}
              <Row
                align="center"
                gap="md"
                className="border-b pb-2 font-medium text-muted-foreground text-sm"
              >
                <div className="w-8"></div>
                <div className="flex-1">Product</div>
                <div className="w-32 text-right">Available</div>
                <div className="w-40">Move Quantity</div>
              </Row>

              {/* Items */}
              {moveItems.map((item, index) => (
                <Row
                  key={item.inventoryEntryId}
                  align="center"
                  gap="md"
                  className={`rounded border p-4 ${
                    item.selected ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <Checkbox
                    checked={item.selected}
                    onCheckedChange={() => toggleItemSelection(index)}
                  />
                  <Row align="center" gap="sm" className="flex-1">
                    <EntityIcon
                      entity="inventory"
                      className="h-4 w-4 text-muted-foreground"
                    />
                    <span className="font-medium">{item.productName}</span>
                  </Row>
                  <div className="w-32 text-right text-muted-foreground">
                    {item.currentQuantity} {item.unit}
                  </div>
                  <Row align="center" gap="sm" className="w-40">
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
                    <Description as="span">{item.unit}</Description>
                  </Row>
                </Row>
              ))}
            </Stack>
          ) : (
            <div className="py-6 text-center text-muted-foreground">
              No inventory items at this location.
            </div>
          )}

          {/* Selection summary */}
          {selectedItems.length > 0 && (
            <MutedBox className="mt-4 rounded-lg">
              <h4 className="mb-2 font-medium">Move Summary</h4>
              <Description>
                {selectedItems.length} item
                {selectedItems.length !== 1 ? "s" : ""} selected
                {targetLocation && (
                  <>
                    {" "}
                    to move to{" "}
                    <span className="font-medium">{targetLocation.name}</span>
                  </>
                )}
              </Description>
            </MutedBox>
          )}
        </div>
      )}
    </FormWrapper>
  );
}
