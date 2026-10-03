/**
 * ReceiveExpenseDialog — put the thing an expense bought onto a shelf.
 *
 * Receiving is always explicit: buying something never moves inventory on its
 * own (the mirror of the no-auto-decrement tenet). Existing stock determines
 * which reviewed action is offered; an occupied inventory slot cannot accept
 * a blind second create.
 * The operator chooses move, add, or create here; the shared receiving command
 * rechecks the choice against current stock and resolves delivery atomically.
 *
 * Import stays stock-neutral: when the Product already has stock, or a stocked
 * Product (e.g. a photo import) may be the same item, the dialog shows that
 * first and defaults to "Nothing new arrived". Units are added only after an
 * explicit "Additional units arrived" and a typed quantity.
 */

import type {
  ExpenseShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  positiveAmount,
  type InventoryReceiveExpenseInput,
  type InventoryReceivingContextOut,
} from "@cubby/schemas/inventory";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FC } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";

import { entityDetailFor } from "~/entity/entity-detail";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { FieldSuggestionProvider } from "~/features/ai/field-suggestion-provider";
import { AmountFieldGroup } from "~/features/inventory/amount-field-group";
import { inventory as inventoryOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { WorkflowDialog } from "~/ui/dialogs/workflow-dialog";
import { getOptionalLocationId, optionalLocationField } from "~/ui/form-fields";
import { ComboboxFieldWithSearch } from "~/ui/form-utils/combobox-field-with-search";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row, Stack } from "~/ui/layout";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";

// A null quantity is "not entered yet": an already-counted Product starts
// blank so units can never be added without typing a number.
const formSchema = z.object({
  location: optionalLocationField,
  addQuantity: z.number().positive().nullable(),
  createAmount: z.object({
    value: z.number().nullable(),
    unit: z.string(),
  }),
});

type ReceiveValues = z.infer<typeof formSchema>;

interface ReceiveExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: ProductShortcode;
  expenseName: string;
  expenseId: ExpenseShortcode;
}

type ProductDetail = DetailRecordOf<"product">;

interface ReceiveBodyProps {
  productId: ProductShortcode;
  expenseId: ExpenseShortcode;
  product: ProductDetail;
  context: InventoryReceivingContextOut;
  onDone: () => void;
}

export const ReceiveExpenseDialog: FC<ReceiveExpenseDialogProps> = ({
  open,
  onOpenChange,
  productId,
  expenseName,
  expenseId,
}) => {
  const { data: product } = useQuery({
    ...entityDetailFor("product").queryOptions(productId),
    enabled: open,
  });
  const { data: context } = useQuery({
    ...inventoryOperations.receivingContext.queryOptions({ productId }),
    enabled: open,
    // Stock is the thing being decided; never decide on a cached count.
    staleTime: 0,
    gcTime: 0,
  });

  return (
    <WorkflowDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Receive into Inventory"
      description={`Put what "${expenseName}" bought onto a shelf.`}
    >
      {product && context ? (
        <ReceiveBody
          productId={productId}
          expenseId={expenseId}
          product={product}
          context={context}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <Description>Loading product…</Description>
      )}
    </WorkflowDialog>
  );
};

const ReceiveBody: FC<ReceiveBodyProps> = ({
  productId,
  expenseId,
  product,
  context,
  onDone,
}) => {
  const stockedMatches = context.matches.filter(
    (match) => match.candidate.inventoryCount > 0,
  );
  const ownUnits = context.stock.reduce(
    (sum, entry) => sum + entry.amount.value,
    0,
  );
  // Every receiving default (counted?, prefill, unit, move/add/create) is the
  // server's; this dialog only renders it.
  const { alreadyCounted, defaultQuantity, defaultUnit } = context;
  const [unitsConfirmed, setUnitsConfirmed] = useState(!alreadyCounted);

  const form = useForm<ReceiveValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      location: null,
      addQuantity: defaultQuantity,
      createAmount: { value: defaultQuantity, unit: defaultUnit },
    },
  });
  const locationId = getOptionalLocationId(form.watch("location"));
  const addQuantity = form.watch("addQuantity");

  const receive = useActionMutation({
    mutationFn: inventoryOperations.receiveExpense.mutationOptions,
    success: "Received into Inventory",
    onSuccess: onDone,
  });
  const receiveAction = (action: InventoryReceiveExpenseInput["action"]) => {
    if (!locationId) return;
    receive.mutate({
      expenseId,
      expectedProductId: productId,
      locationId,
      action,
    });
  };

  const plan =
    context.locationPlans.find((entry) => entry.locationId === locationId)
      ?.plan ?? context.suggestedPlan;
  const entryHere =
    plan.kind === "add"
      ? context.stock.find((entry) => entry.id === plan.entryId)
      : undefined;

  const countedNotice = alreadyCounted ? (
    <Stack gap="sm">
      {stockedMatches.map((match) => (
        <Alert key={match.candidate.id}>
          <AlertTitle>
            This may already be counted as {match.candidate.name}
          </AlertTitle>
          <AlertDescription>
            {match.candidate.inventoryCount} on hand
            {match.evidence ? ` · ${match.evidence}` : ""}.{" "}
            {match.warnings.map((warning) => `${warning} `)}
            <Link
              to="/recommendations/workbench"
              search={{
                kind: "product-match",
                source: productId,
                candidate: match.candidate.id,
              }}
              className="font-medium text-primary hover:underline"
            >
              Review this match
            </Link>{" "}
            before receiving.
          </AlertDescription>
        </Alert>
      ))}
      {context.stock.length > 0 ? (
        <Description>
          {product.name} already has {ownUnits} on hand (
          {context.stock
            .map(
              (entry) =>
                `${entry.amount.value} ${entry.amount.unit} at ${entry.locationName}`,
            )
            .join(", ")}
          ). Importing this purchase did not change it.
        </Description>
      ) : null}
      {!unitsConfirmed ? (
        <Row gap="sm" wrap>
          <Button onClick={onDone}>Nothing new arrived</Button>
          <Button variant="outline" onClick={() => setUnitsConfirmed(true)}>
            Additional units arrived
          </Button>
        </Row>
      ) : (
        <Description>
          Enter how many additional units arrived. Nothing is added until you
          do.
        </Description>
      )}
    </Stack>
  ) : null;

  const body = () => {
    if (!unitsConfirmed) return null;

    // A unique item already on a shelf: offer the move, never a second entry.
    if (context.suggestedPlan.kind === "move") {
      const move = context.suggestedPlan;
      const soleEntry = context.stock.find(
        (entry) => entry.id === move.entryId,
      );
      return (
        <Stack gap="md">
          <Description>
            {product.name} is already stocked at {soleEntry?.locationName}. It's
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
                locationId === move.fromLocationId
              }
              onClick={() => {
                if (!locationId) return;
                receiveAction({ kind: "move", entryId: move.entryId });
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
                value={addQuantity ?? ""}
                onChange={(e) =>
                  form.setValue(
                    "addQuantity",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
              <Button
                disabled={receive.isPending || !((addQuantity ?? 0) > 0)}
                onClick={() => {
                  const add = form.getValues("addQuantity");
                  if (!add || !(add > 0)) return;
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
    <FormProvider {...form}>
      <FieldSuggestionProvider
        entity="inventory"
        mode="create"
        staticBasis={{ productId }}
        fieldKeys={["locationId"]}
        paths={{ locationId: "location" }}
      >
        <Stack gap="md">
          {countedNotice}
          {body()}
        </Stack>
      </FieldSuggestionProvider>
    </FormProvider>
  );
};
