/**
 * ReceiveExpenseDialog — put the thing an expense bought onto a shelf.
 *
 * Receiving is always explicit: buying something never moves inventory on its
 * own (the mirror of the no-auto-decrement tenet). Existing stock determines
 * which reviewed action is offered; an occupied inventory slot cannot accept
 * a blind second create.
 * The operator chooses move, add, or create here; the shared receiving command
 * rechecks the choice against current stock and resolves delivery atomically.
 */

import type {
  ExpenseShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  positiveAmount,
  type InventoryReceiveExpenseInput,
} from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { type FC } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import {
  getOptionalLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  AmountFieldGroup,
  DEFAULT_AMOUNT_UNIT,
} from "~/app/_components/inventory/amount-field-group";
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
import { entityDetailFor } from "~/entities/entity-detail";
import { inventory as inventoryOperations } from "~/integrations/tanstack-query/generated/catalog.gen";

const formSchema = z.object({
  location: optionalLocationField,
  addQuantity: z.number().positive(),
  createAmount: positiveAmount,
});

type ReceiveValues = z.infer<typeof formSchema>;

interface ReceiveExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: ProductShortcode;
  expenseName: string;
  expenseId: ExpenseShortcode;
}

export const ReceiveExpenseDialog: FC<ReceiveExpenseDialogProps> = ({
  open,
  onOpenChange,
  productId,
  expenseName,
  expenseId,
}) => {
  const { data: product, isLoading } = useQuery({
    ...entityDetailFor("product").queryOptions(productId),
    enabled: open,
  });

  const form = useForm<ReceiveValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      location: null,
      addQuantity: 1,
      createAmount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    },
  });
  const locationId = getOptionalLocationId(form.watch("location"));

  const close = (nextOpen: boolean) => {
    if (!nextOpen) form.reset();
    onOpenChange(nextOpen);
  };
  const receive = useActionMutation({
    mutationFn: inventoryOperations.receiveExpense.mutationOptions,
    success: "Received into Inventory",
    onSuccess: () => close(false),
  });
  const receiveAction = (action: InventoryReceiveExpenseInput["action"]) => {
    if (!locationId) return;
    receive.mutate({ expenseId, locationId, action });
  };

  const entries = product?.inventoryEntry ?? [];
  // `expectedQuantity: 1` marks a one-of-a-kind item. Such a product doesn't
  // get a second entry when it turns up somewhere else — it moves.
  const isUnique = product?.expectedQuantity === 1;
  const soleEntry = entries.length === 1 ? entries[0] : undefined;
  const entryHere = locationId
    ? entries.find((e) => e.location.id === locationId)
    : undefined;

  const body = () => {
    if (isLoading || !product) {
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
              disabled={
                receive.isPending ||
                !locationId ||
                locationId === soleEntry.location.id
              }
              onClick={() => {
                if (!locationId) return;
                receiveAction({ kind: "move", entryId: soleEntry.id });
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
                disabled={receive.isPending || !(form.watch("addQuantity") > 0)}
                onClick={() => {
                  const add = form.getValues("addQuantity");
                  if (!(add > 0)) return;
                  receiveAction({
                    kind: "add",
                    entryId: entryHere.id,
                    amount: { value: add, unit: entryHere.amount.unit },
                  });
                }}
              >
                Add to count
              </Button>
            </Row>
          </Stack>
        ) : (
          <Stack gap="sm">
            <Description>
              {product.name} is not stocked at this location.
            </Description>
            <AmountFieldGroup
              form={form}
              valuePath="createAmount.value"
              unitPath="createAmount.unit"
              step="any"
            />
            <Row justify="end">
              <Button
                disabled={receive.isPending}
                onClick={() => {
                  const parsed = positiveAmount.safeParse(
                    form.getValues("createAmount"),
                  );
                  if (!parsed.success) {
                    void form.trigger("createAmount");
                    return;
                  }
                  receiveAction({ kind: "create", amount: parsed.data });
                }}
              >
                Add to inventory
              </Button>
            </Row>
          </Stack>
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
