/**
 * ReceiveExpenseDialog — put the thing an expense bought onto a shelf.
 *
 * Receiving is always explicit: buying something never moves inventory on its
 * own (the mirror of the no-auto-decrement tenet). What makes this more than a
 * thin wrapper over QuickInventoryAdd is that the product may already be
 * stocked, and `InventoryEntry` carries a partial unique index on
 * (productId, locationId) — so a blind create raises a bare constraint error.
 * The three real cases are branched here, where the operator can see the
 * decision, rather than by turning createInventoryEntry into a silent upsert.
 */

import type {
  InventoryShortcode,
  ProductShortcode,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FC, useMemo } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import {
  getOptionalLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { QuickInventoryAdd } from "~/app/_components/inventory/quick-inventory-add";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { problems as problemOperations } from "~/lib/problems.functions";

const formSchema = z.object({
  location: optionalLocationField,
  addQuantity: z.number().positive(),
});

type ReceiveValues = z.infer<typeof formSchema>;

interface ReceiveExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: ProductShortcode;
  expenseName: string;
  /** The purchase whose open `arrived` finding this receive may close. */
  purchaseId: PurchaseShortcode | null;
}

export const ReceiveExpenseDialog: FC<ReceiveExpenseDialogProps> = ({
  open,
  onOpenChange,
  productId,
  expenseName,
  purchaseId,
}) => {
  const { data: product, isLoading } = useQuery({
    ...entityDetailFor("product").queryOptions(productId),
    enabled: open,
  });

  const form = useForm<ReceiveValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { location: null, addQuantity: 1 },
  });
  const locationId = getOptionalLocationId(form.watch("location"));

  const updateInventory = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("inventory", "update"),
    entity: "inventory",
  });

  const initialProduct = useMemo(
    () =>
      product
        ? {
            id: product.id,
            name: `${product.name} (${product.manufacturer})`,
          }
        : null,
    [product],
  );

  const close = (nextOpen: boolean) => {
    if (!nextOpen) form.reset();
    onOpenChange(nextOpen);
  };
  const resolveArrived = useMutation(
    problemOperations.resolveArrivedFindings.mutationOptions(),
  );
  // Receiving stays interactive; the finding just learns about it. The server
  // keeps the finding open until every product line of the purchase landed.
  const received = () => {
    if (purchaseId) resolveArrived.mutate({ purchaseId });
    close(false);
  };

  const entries = product?.inventoryEntry ?? [];
  // `expectedQuantity: 1` marks a one-of-a-kind item. Such a product doesn't
  // get a second entry when it turns up somewhere else — it moves.
  const isUnique = product?.expectedQuantity === 1;
  const soleEntry = entries.length === 1 ? entries[0] : undefined;
  const entryHere = locationId
    ? entries.find((e) => e.location.id === locationId)
    : undefined;

  const applyUpdate = async (
    id: InventoryShortcode,
    data: Parameters<typeof updateInventory.mutateAsync>[0]["data"],
  ) => {
    await updateInventory.mutateAsync({ id, data });
    received();
  };

  const body = () => {
    if (isLoading || !product || !initialProduct) {
      return <Description>Loading product…</Description>;
    }

    // A unique item already on a shelf: offer the move, never a second entry.
    if (isUnique && soleEntry) {
      return (
        <Stack gap="md">
          <Description>
            {product.name} is already stocked at {soleEntry.location.name}. It's
            a one-of-a-kind item, so receiving it again moves it rather than
            adding a second entry.
          </Description>
          <ComboboxFieldWithSearch
            form={form}
            name="location"
            label="Move to"
            searchType="location"
            suggestField="locationId"
          />
          <Row justify="end">
            <Button
              disabled={!locationId || locationId === soleEntry.location.id}
              onClick={() => {
                if (!locationId) return;
                void applyUpdate(soleEntry.id, { locationId });
              }}
            >
              Move here
            </Button>
          </Row>
        </Stack>
      );
    }

    return (
      <Stack gap="md">
        <ComboboxFieldWithSearch
          form={form}
          name="location"
          label="Location"
          searchType="location"
          suggestField="locationId"
        />
        {!locationId ? (
          <Description>Pick where this one goes.</Description>
        ) : entryHere ? (
          // Already stocked right here — the unique index forbids a second row,
          // so top up the existing one instead.
          <Stack gap="sm">
            <Description>
              Already stocked here: {entryHere.amount.value}{" "}
              {entryHere.amount.unit}. Receiving adds to that count.
            </Description>
            <Row gap="sm" align="center">
              <Input
                type="number"
                step="any"
                min="0"
                className="w-24"
                aria-label="Quantity to add"
                value={form.watch("addQuantity")}
                onChange={(e) =>
                  form.setValue("addQuantity", Number(e.target.value))
                }
              />
              <Button
                disabled={!(form.watch("addQuantity") > 0)}
                onClick={() => {
                  const add = form.getValues("addQuantity");
                  if (!(add > 0)) return;
                  void applyUpdate(entryHere.id, {
                    amount: {
                      ...entryHere.amount,
                      value: entryHere.amount.value + add,
                    },
                  });
                }}
              >
                Add to count
              </Button>
            </Row>
          </Stack>
        ) : (
          <QuickInventoryAdd
            locationId={locationId}
            initialProduct={initialProduct}
            onSuccess={received}
          />
        )}
      </Stack>
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Receive into Inventory</DialogTitle>
          <DialogDescription>
            Put what "{expenseName}" bought onto a shelf.
          </DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <FieldSuggestionProvider
            entity="inventory"
            mode="create"
            staticBasis={{ productId }}
            fieldKeys={["locationId"]}
            paths={{ locationId: "location" }}
          >
            {body()}
          </FieldSuggestionProvider>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
};
