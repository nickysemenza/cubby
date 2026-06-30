import { unsafeInventoryId } from "@cubby/schemas/identifiers";
import type { InventoryBulkOperationItem } from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  buildLocationComboboxItem,
  buildProductComboboxItem,
} from "~/app/_components/combobox/combobox-builders";
import {
  getLocationId,
  getProductId,
  inventoryItemWithIdFields,
  requiredLocationField,
} from "~/app/_components/form-fields";
import {
  ComboboxFieldWithSearch,
  FormWrapper,
  getSubmitButtonText,
} from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { BarcodeScannerButton } from "~/app/_components/inventory/barcode-scanner-button";
import {
  useInventoryInvalidation,
  useUpcLookup,
} from "~/app/_components/inventory/hooks";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC } from "~/trpc/react";

// Schema for a single inventory item using shared field schemas
const inventoryItemSchema = inventoryItemWithIdFields;

// Schema for the entire form
const formSchema = z.object({
  location: requiredLocationField,
  items: z.array(inventoryItemSchema),
});

type BulkInventoryFormValues = z.input<typeof formSchema>;

interface BulkInventoryFormProps {
  initialLocationId?: string;
}

export default function BulkInventoryForm({
  initialLocationId,
}: BulkInventoryFormProps) {
  const api = useTRPC();
  const invalidateInventory = useInventoryInvalidation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Initialize the form
  const form = useForm<BulkInventoryFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      location: undefined,
      items: [],
    },
  });

  // Set up the field array for inventory items
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Watch the location field to load items when changed
  const selectedLocation = form.watch("location");

  // Fetch locations for the location selector
  const { data: locationsResp } = useQuery(
    api.location.list.queryOptions({
      pagination: { pageIndex: 0, pageSize: 100 },
      sort: { orderBy: "name", direction: "asc" },
      filters: {},
    }),
  );

  const locations = useMemo(() => locationsResp?.items || [], [locationsResp]);

  // Update URL when location changes
  useEffect(() => {
    if (selectedLocation && selectedLocation.id !== initialLocationId) {
      navigate({
        to: "/inventory/bulk-edit",
        search: { locationId: selectedLocation.id },
        replace: true,
      });
    }
  }, [selectedLocation, initialLocationId, navigate]);

  // Set initial location from URL
  useEffect(() => {
    if (
      initialLocationId &&
      locations.length > 0 &&
      selectedLocation?.id !== initialLocationId
    ) {
      const location = locations.find((loc) => loc.id === initialLocationId);
      if (location) {
        form.setValue("location", buildLocationComboboxItem(location));
      }
    }
  }, [initialLocationId, locations, form, selectedLocation]);

  // Fetch existing inventory items when location is selected.
  // pageSize:100 caps how many existing entries we load into the form. Because
  // bulkProcess deletes-on-omit, any existing entry NOT submitted is removed —
  // so a truncated or still-loading set is a silent-wipe hazard. We surface
  // status + totalCount below and refuse to submit when the loaded set can't be
  // trusted as the complete picture.
  const BULK_EDIT_PAGE_SIZE = 100;
  const {
    data: inventoryItemsData,
    refetch: refetchInventoryItems,
    status: inventoryStatus,
    isFetching: inventoryFetching,
    dataUpdatedAt,
  } = useQuery({
    ...api.inventory.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: BULK_EDIT_PAGE_SIZE },
      filters: { locationIdFilter: selectedLocation?.id ?? "" },
    }),
    enabled: !!selectedLocation,
  });

  // The loaded set is truncated when the location holds more entries than one
  // page can show — saving would delete every entry past the first page.
  const loadedCount = inventoryItemsData?.items.length ?? 0;
  const totalCount = inventoryItemsData?.meta.totalCount ?? 0;
  const isTruncated = !!selectedLocation && totalCount > loadedCount;

  // Load existing inventory items when location changes
  useEffect(() => {
    if (selectedLocation && inventoryItemsData?.items) {
      form.setValue("items", []);
      const existingItems: z.infer<typeof inventoryItemSchema>[] =
        inventoryItemsData.items.map((item) => ({
          product: buildProductComboboxItem(item.product),
          amount: item.amount,
          id: item.id,
        }));
      form.setValue("items", existingItems);
    } else {
      form.setValue("items", []);
    }
  }, [selectedLocation, inventoryItemsData, form]);

  // Add a new empty inventory item
  const addInventoryItem = () => {
    append({
      product: null,
      amount: { value: 1, unit: "" },
    });
  };

  // Bulk process mutation
  const bulkProcessMutation = useMutation(
    api.inventory.bulkProcess.mutationOptions({
      onSuccess: (data) => {
        refetchInventoryItems();
        invalidateInventory(data);
      },
    }),
  );

  // UPC lookup for barcode scanning
  const { lookupUpc, isPending: isUpcPending } = useUpcLookup();

  // Handle barcode scan for a specific item index
  const handleBarcodeScan = useCallback(
    async (barcode: string, index: number) => {
      const product = await lookupUpc(barcode);
      if (product) {
        form.setValue(
          `items.${index}.product`,
          buildProductComboboxItem(product),
        );
        toast.success(`Found: ${product.name}`);
      }
    },
    [lookupUpc, form],
  );

  // Submit handler
  const onSubmit = async (values: BulkInventoryFormValues) => {
    const location = values.location;
    if (!location) {
      setError("Please select a location");
      return;
    }
    // Safety gate: bulkProcess deletes any existing entry not in this submit.
    // Refuse if the current inventory snapshot isn't a complete, settled load,
    // or the save would silently delete entries the user never saw.
    if (inventoryStatus !== "success" || inventoryFetching) {
      setError(
        "Inventory is still loading for this location — wait for it to finish before saving. Saving on a partial load would delete the entries that haven't loaded yet.",
      );
      return;
    }
    if (isTruncated) {
      setError(
        `This location has ${totalCount} entries but only ${loadedCount} are shown here. Saving would permanently remove the ${
          totalCount - loadedCount
        } that aren't loaded. Audit this location in the inventory session instead, or split it into smaller locations.`,
      );
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const validItems = values.items.filter(
        (
          item,
        ): item is typeof item & {
          product: NonNullable<typeof item.product>;
        } =>
          item.product !== null &&
          item.amount.value !== null &&
          item.amount.unit !== "",
      );
      const locationId = getLocationId(location);
      const processItems: InventoryBulkOperationItem[] = validItems.map(
        (item) => {
          const res: InventoryBulkOperationItem = {
            locationId,
            ...(item.id && { id: unsafeInventoryId(item.id) }),
            productId: getProductId(item.product),
            amount: item.amount,
          };
          return res;
        },
      );
      await bulkProcessMutation.mutateAsync({
        locationId,
        items: processItems,
        // Stamp the snapshot's fetch time so the server can reject a stale commit
        // (something changed at this location since) rather than delete-on-omit.
        loadedAt: dataUpdatedAt ? new Date(dataUpdatedAt) : undefined,
      });
      toast.success(`Successfully updated inventory for ${location.name}`);
      setIsSubmitting(false);
    } catch (err) {
      // A CONFLICT is the staleness guard firing — refetch so the form shows the
      // current snapshot, and surface the server's message (not a generic one).
      refetchInventoryItems();
      setError(getErrorMessage(err));
      setIsSubmitting(false);
    }
  };

  return (
    <FormWrapper
      form={form}
      onSubmit={onSubmit}
      error={error ?? undefined}
      isPending={isSubmitting}
      submitButtonText={getSubmitButtonText("edit")}
      stickyFooter
      footerStart={
        <span className="truncate font-mono text-2xs text-muted-foreground uppercase tabular-nums">
          {fields.length} item{fields.length === 1 ? "" : "s"}
        </span>
      }
    >
      <div className="mb-4 max-w-md">
        <ComboboxFieldWithSearch
          form={form}
          name="location"
          label="Location"
          searchType="location"
        />
      </div>

      {selectedLocation && isTruncated && (
        <div className="mb-4 rounded border-2 border-warning bg-warning/10 p-2 text-warning text-xs">
          Showing {loadedCount} of {totalCount} entries. Bulk edit can't safely
          save a partial load (it would delete the {totalCount - loadedCount}{" "}
          not shown). Use the inventory session to audit this location.
        </div>
      )}

      {selectedLocation && (
        <>
          <Row align="center" justify="between" className="mb-4">
            <h3 className="font-medium text-lg">
              Inventory for {selectedLocation.name}
            </h3>
            <Button type="button" onClick={addInventoryItem} size="sm">
              <Plus className="mr-1 h-4 w-4" />
              Add Item
            </Button>
          </Row>

          <Stack gap="sm">
            {fields.length > 0 ? (
              fields.map((field, index) => (
                <Row
                  key={field.id}
                  align="center"
                  gap="sm"
                  className="rounded border p-1"
                >
                  <div className="flex-1">
                    <ComboboxFieldWithSearch
                      form={form}
                      name={`items.${index}.product`}
                      label="Product"
                      searchType="product"
                    />
                  </div>

                  <div className="w-64">
                    <AmountFieldGroup
                      form={form}
                      valuePath={`items.${index}.amount.value`}
                      unitPath={`items.${index}.amount.unit`}
                    />
                  </div>

                  <BarcodeScannerButton
                    onScan={(barcode) => handleBarcodeScan(barcode, index)}
                    disabled={isUpcPending}
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(index)}
                    className="shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </Row>
              ))
            ) : (
              <div className="py-4 text-center text-muted-foreground">
                No inventory items yet.
              </div>
            )}
          </Stack>
        </>
      )}
    </FormWrapper>
  );
}
