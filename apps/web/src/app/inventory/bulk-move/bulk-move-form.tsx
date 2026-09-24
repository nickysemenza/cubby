import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  BulkMoveItem,
  inventoryListItemOut,
} from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  getLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { FormWrapper } from "~/app/_components/form-utils";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import {
  DestinationLocationField,
  resolveDestination,
} from "~/app/_components/inventory/destination-location-picker";
import { useInventoryInvalidation } from "~/app/_components/inventory/hooks";
import { inventory } from "~/app/inventory/inventory.functions";
import { Row, Stack } from "~/components/layout";
import { MutedBox } from "~/components/layout/muted-box";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { EntityIcon } from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { entityListFor } from "~/entities/entity-list.functions";
import { getAppErrorDetails } from "~/lib/error-utils";

type InventoryListItem = z.infer<typeof inventoryListItemOut>;

interface MoveItem {
  inventoryEntryId: string;
  productName: string;
  currentQuantity: number;
  moveQuantity: number;
  unit: string;
  selected: boolean;
}

const formSchema = z.object({
  sourceLocation: optionalLocationField,
  targetLocation: optionalLocationField,
});

type BulkMoveFormValues = z.infer<typeof formSchema>;

interface BulkMoveFormProps {
  initialSourceLocationId?: string;
}

function BulkMoveInventoryList({
  locationName,
  items,
  onToggleItem,
  onToggleAll,
  onUpdateQuantity,
}: {
  locationName: string;
  items: MoveItem[];
  onToggleItem: (index: number) => void;
  onToggleAll: () => void;
  onUpdateQuantity: (index: number, quantity: number) => void;
}) {
  const allSelected = items.every((item) => item.selected);
  return (
    <>
      <Row align="center" justify="between" className="mb-4">
        <h3 className="text-lg font-medium">Items at {locationName}</h3>
        {items.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onToggleAll}
          >
            {allSelected ? "Deselect All" : "Select All"}
          </Button>
        )}
      </Row>
      {items.length === 0 ? (
        <div className="py-6 text-center text-muted-foreground">
          No inventory items at this location.
        </div>
      ) : (
        <Stack gap="sm">
          <Row
            align="center"
            gap="md"
            className="border-b pb-2 text-sm font-medium text-muted-foreground"
          >
            <div className="w-8"></div>
            <div className="flex-1">Product</div>
            <div className="w-32 text-right">Available</div>
            <div className="w-40">Move Quantity</div>
          </Row>

          {items.map((item, index) => (
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
                onCheckedChange={() => onToggleItem(index)}
              />
              <Row align="center" gap="sm" className="flex-1">
                <EntityIcon
                  entity="inventory"
                  className="size-4 text-muted-foreground"
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
                  onChange={(event) =>
                    onUpdateQuantity(index, parseFloat(event.target.value) || 0)
                  }
                  className="w-20"
                  disabled={!item.selected}
                />
                <Description as="span">{item.unit}</Description>
              </Row>
            </Row>
          ))}
        </Stack>
      )}
    </>
  );
}

export default function BulkMoveForm({
  initialSourceLocationId,
}: BulkMoveFormProps) {
  const invalidateInventory = useInventoryInvalidation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveItems, setMoveItems] = useState<MoveItem[]>([]);
  const navigate = useNavigate();

  const form = useForm<BulkMoveFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sourceLocation: null,
      targetLocation: null,
    },
  });

  const sourceLocation = form.watch("sourceLocation");
  const targetLocation = form.watch("targetLocation");

  // Resolve the deep-linked `?sourceLocationId=` directly. Both pickers run
  // their own search, so this fetch exists only to seed the source field —
  // looking the id up in a first page of locations silently failed for
  // anything further down.
  const { data: initialSourceLocation } = useQuery({
    ...entityDetailFor("location").queryOptions(
      initialSourceLocationId ?? "LOC-0000",
    ),
    enabled: !!initialSourceLocationId,
  });

  useEffect(() => {
    if (sourceLocation && sourceLocation.id !== initialSourceLocationId) {
      navigate({
        to: "/inventory/bulk-move",
        search: { sourceLocationId: sourceLocation.id },
        replace: true,
      });
    }
  }, [sourceLocation, initialSourceLocationId, navigate]);

  useEffect(() => {
    if (
      initialSourceLocation &&
      initialSourceLocation.id === initialSourceLocationId &&
      sourceLocation?.id !== initialSourceLocationId
    ) {
      form.setValue(
        "sourceLocation",
        buildLocationComboboxItem(initialSourceLocation),
      );
    }
  }, [initialSourceLocation, initialSourceLocationId, form, sourceLocation]);

  // Fetch inventory items from source location. pageSize caps how many entries
  // the move list can show — past that the user can't select what they can't
  // see, so the truncated count is surfaced rather than silently dropped.
  const BULK_MOVE_PAGE_SIZE = 100;
  const { data: inventoryItemsData, refetch: refetchInventoryItems } = useQuery(
    {
      ...entityListFor("inventory").queryOptions({
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: { pageIndex: 0, pageSize: BULK_MOVE_PAGE_SIZE },
        filters: { locationIdFilter: sourceLocation?.id ?? "" },
      }),
      enabled: !!sourceLocation,
    },
  );

  const loadedCount = inventoryItemsData?.items.length ?? 0;
  const totalCount = inventoryItemsData?.meta.totalCount ?? 0;
  const isTruncated = !!sourceLocation && totalCount > loadedCount;

  // Seed moveItems once per sourceLocation.id rather than on every
  // inventoryItemsData identity change — a background refetch would
  // otherwise silently discard in-progress selections/quantities.
  // `seededLocationIdRef` is reset to null after a successful move so the
  // post-move refetch (moved items gone, remainders reduced) reseeds once.
  const seededLocationIdRef = useRef<string | null>(null);
  const sourceLocationId = sourceLocation?.id;
  useEffect(() => {
    if (!sourceLocationId) {
      seededLocationIdRef.current = null;
      setMoveItems([]);
      return;
    }
    if (seededLocationIdRef.current === sourceLocationId) return;
    if (!inventoryItemsData?.items) {
      // New location still loading — don't leave the previous location's rows
      // selectable meanwhile.
      setMoveItems([]);
      return;
    }
    seededLocationIdRef.current = sourceLocationId;
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
  }, [sourceLocationId, inventoryItemsData]);

  const toggleItemSelection = (index: number) => {
    setMoveItems((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, selected: !item.selected } : item,
      ),
    );
  };

  const toggleSelectAll = () => {
    const allSelected = moveItems.every((item) => item.selected);
    setMoveItems((prev) =>
      prev.map((item) => ({ ...item, selected: !allSelected })),
    );
  };

  const updateMoveQuantity = (index: number, quantity: number) => {
    setMoveItems((prev) =>
      prev.map((item, i) =>
        i === index
          ? { ...item, moveQuantity: Math.min(quantity, item.currentQuantity) }
          : item,
      ),
    );
  };

  const selectedItems = moveItems.filter((item) => item.selected);

  const bulkMoveMutation = useMutation(
    inventory.bulkMove.mutationOptions({
      onSuccess: (data) => {
        // Force the next fetch to reseed — moved items are gone from the
        // source location and remainders have reduced quantities.
        seededLocationIdRef.current = null;
        refetchInventoryItems();
        invalidateInventory(data);
      },
    }),
  );

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
        inventoryEntryId: parseShortcodeFor("inventory", item.inventoryEntryId),
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

      setMoveItems((prev) =>
        prev.map((item) => ({ ...item, selected: false })),
      );
      setIsSubmitting(false);
    } catch (err) {
      setError(getAppErrorDetails(err).message);
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
      <Row align="end" gap="md" className="mb-4">
        <div className="flex-1">
          <ComboboxFieldWithSearch
            form={form}
            name="sourceLocation"
            label="From Location"
            searchType="location"
          />
        </div>
        <ArrowRightIcon className="mb-2 size-6 text-muted-foreground" />
        <div className="flex-1">
          <DestinationLocationField
            form={form}
            name="targetLocation"
            label="To Location"
            sourceLocationIds={
              sourceLocation ? getLocationId(sourceLocation) : undefined
            }
          />
        </div>
      </Row>

      {sourceLocation && isTruncated && (
        <div className="mb-4 rounded border-2 border-warning bg-warning/10 p-2 text-xs text-warning-ink">
          Showing {loadedCount} of {totalCount} entries. The{" "}
          {totalCount - loadedCount} not listed can't be selected or moved. Move
          these first, then reload to see the rest.
        </div>
      )}

      {sourceLocation && (
        <div>
          <BulkMoveInventoryList
            locationName={sourceLocation.name}
            items={moveItems}
            onToggleItem={toggleItemSelection}
            onToggleAll={toggleSelectAll}
            onUpdateQuantity={updateMoveQuantity}
          />

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
