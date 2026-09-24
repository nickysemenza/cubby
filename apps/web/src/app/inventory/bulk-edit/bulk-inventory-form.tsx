import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { InventoryBulkOperationItem } from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  getLocationId,
  getProductShortcode,
  inventoryItemWithIdFields,
  requiredLocationField,
} from "~/app/_components/form-fields";
import { FormWrapper, getSubmitButtonText } from "~/app/_components/form-utils";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import {
  AmountFieldGroup,
  DEFAULT_AMOUNT_UNIT,
} from "~/app/_components/inventory/amount-field-group";
import { BarcodeScannerButton } from "~/app/_components/inventory/barcode-scanner-button";
import {
  useInventoryInvalidation,
  useUpcLookup,
} from "~/app/_components/inventory/hooks";
import { inventory } from "~/app/inventory/inventory.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { getErrorMessage } from "~/lib/error-utils";

const inventoryItemSchema = inventoryItemWithIdFields;

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
  const invalidateInventory = useInventoryInvalidation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const form = useForm<BulkInventoryFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      location: undefined,
      items: [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const selectedLocation = form.watch("location");

  // Resolve the deep-linked `?locationId=` directly. The picker runs its own
  // search, so this fetch exists only to seed the field — looking the id up in
  // a first page of locations silently failed for anything further down.
  const { data: initialLocation } = useQuery({
    ...entityDetailFor("location").queryOptions(initialLocationId ?? ""),
    enabled: !!initialLocationId,
  });

  useEffect(() => {
    if (selectedLocation && selectedLocation.id !== initialLocationId) {
      navigate({
        to: "/inventory/bulk-edit",
        search: { locationId: selectedLocation.id },
        replace: true,
      });
    }
  }, [selectedLocation, initialLocationId, navigate]);

  useEffect(() => {
    if (
      initialLocation &&
      initialLocation.id === initialLocationId &&
      selectedLocation?.id !== initialLocationId
    ) {
      form.setValue("location", buildLocationComboboxItem(initialLocation));
    }
  }, [initialLocation, initialLocationId, form, selectedLocation]);

  const snapshotInput = selectedLocation
    ? { locationId: selectedLocation.id, placement: "stock" as const }
    : undefined;
  const snapshotPolicy = snapshotInput
    ? inventory.locationSnapshot.policy(snapshotInput)
    : undefined;
  const {
    data: inventoryItemsData,
    refetch: refetchInventoryItems,
    status: inventoryStatus,
    isFetching: inventoryFetching,
  } = useQuery({
    queryKey: snapshotInput
      ? inventory.locationSnapshot.queryKey(snapshotInput)
      : ["inventory", "locationSnapshot", "unselected"],
    queryFn: snapshotInput
      ? ({ signal }) =>
          inventory.locationSnapshot.call(snapshotInput, { signal })
      : skipToken,
    meta: snapshotPolicy?.meta,
    ...snapshotPolicy?.freshness,
  });

  // Seed the items field array once per selectedLocation.id rather than on
  // every inventoryItemsData identity change — a background refetch (window
  // refocus, an unrelated valuation job) would otherwise silently wipe
  // in-progress edits. `seededLocationIdRef` is reset to null after a
  // successful save so the post-save refetch (which returns real ids for
  // newly-created items) reseeds once — required so a second save in the
  // same session updates rather than re-creates those entries.
  const seededLocationIdRef = useRef<string | null>(null);
  const selectedLocationId = selectedLocation?.id;
  useEffect(() => {
    if (!selectedLocationId) {
      seededLocationIdRef.current = null;
      form.setValue("items", []);
      return;
    }
    if (seededLocationIdRef.current === selectedLocationId) return;
    if (!inventoryItemsData?.items) {
      // New location still loading — don't leave the previous location's rows
      // in the field array meanwhile (submit is already safety-gated on a
      // settled load; this keeps the visible rows honest too).
      form.setValue("items", []);
      return;
    }
    seededLocationIdRef.current = selectedLocationId;
    const existingItems: z.infer<typeof inventoryItemSchema>[] =
      inventoryItemsData.items.map((item) => ({
        product: {
          id: item.product.id,
          name: `${item.product.name} (${item.product.manufacturer})`,
        },
        amount: item.amount,
        id: item.id,
      }));
    form.setValue("items", existingItems);
  }, [selectedLocationId, inventoryItemsData, form]);

  const addInventoryItem = () => {
    append({
      product: null,
      amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    });
  };

  const bulkProcessMutation = useMutation(
    inventory.bulkProcess.mutationOptions({
      onSuccess: (data) => {
        // Force the next fetch to reseed the form so newly-created items pick
        // up their real ids (a same-session re-save otherwise re-creates them).
        seededLocationIdRef.current = null;
        refetchInventoryItems();
        invalidateInventory(data);
      },
    }),
  );

  const { lookupUpc, isPending: isUpcPending } = useUpcLookup();

  const handleBarcodeScan = useCallback(
    async (barcode: string, index: number) => {
      const product = await lookupUpc(barcode);
      if (product) {
        form.setValue(`items.${index}.product`, {
          id: product.id,
          name: `${product.name} (${product.manufacturer})`,
        });
        toast.success(`Found: ${product.name}`);
      }
    },
    [lookupUpc, form],
  );

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
            ...(item.id && { id: parseShortcodeFor("inventory", item.id) }),
            productId: getProductShortcode(item.product),
            amount: item.amount,
          };
          return res;
        },
      );
      await bulkProcessMutation.mutateAsync({
        locationId,
        items: processItems,
        snapshotToken: inventoryItemsData?.snapshotToken,
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

      {selectedLocation && (
        <>
          <Row align="center" justify="between" className="mb-4">
            <h3 className="text-lg font-medium">
              Inventory for {selectedLocation.name}
            </h3>
            <Button type="button" onClick={addInventoryItem} size="sm">
              <PlusIcon className="mr-1 size-4" />
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
                      productIntent="stock"
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
                    <XIcon className="size-4" />
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
